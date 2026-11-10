/**
 * Single owner of maintenance-cycle state.
 *
 * Every change to a cycle's status, a cycle↔booking link, or a subscription's counters goes
 * through this module so the rules live in one place:
 *   open → booked      a booking is linked (linkBookingToCycle)
 *   booked → open      the linked booking is cancelled/denied (onBookingCancelled)
 *   booked → completed the linked booking is completed (onBookingCompleted)
 *   open → missed      the window ended with no booking (markCycleMissed, cron only)
 *   open → void        paused/cancelled subscription or forgiven miss (voidOpenCycles)
 * Updates are conditional on the expected current status so repeated runs are harmless, and
 * every change is written to subscription_cycle_audit.
 */
import {
  computeCycleWindow,
  getEffectiveWindowEnd,
  getPushbackEnd,
  toNYDate,
  todayNY
} from "./lifecycle.js";

export const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed", "reschedule_requested", "completed"];
const MIN_ADVANCE_MS = 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

export async function audit(sb, entry) {
  const { error } = await sb.from("subscription_cycle_audit").insert({
    subscription_id: entry.subscription_id ?? null,
    cycle_id: entry.cycle_id ?? null,
    booking_id: entry.booking_id ?? null,
    action: entry.action,
    actor: entry.actor || "system",
    before: entry.before ?? null,
    after: entry.after ?? null,
    notes: entry.notes ?? null
  });
  if (error) console.error("[CYCLE_AUDIT] insert failed", entry.action, error);
}

/** Map a service category label ("Combined Package", "Interior") to a plan category. */
export function normalizePlanCategory(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("combined") || v.includes("full")) return "combined";
  if (v.includes("interior")) return "interior";
  if (v.includes("exterior")) return "exterior";
  return null;
}

export async function getActiveLinkForBooking(sb, bookingId) {
  const { data } = await sb
    .from("subscription_cycle_bookings")
    .select("*")
    .eq("booking_id", bookingId)
    .is("released_at", null)
    .maybeSingle();
  return data || null;
}

export async function getActiveLinkForCycle(sb, cycleId) {
  const { data } = await sb
    .from("subscription_cycle_bookings")
    .select("*")
    .eq("cycle_id", cycleId)
    .is("released_at", null)
    .maybeSingle();
  return data || null;
}

async function getCycle(sb, cycleId) {
  const { data } = await sb.from("subscription_cycles").select("*").eq("id", cycleId).maybeSingle();
  return data || null;
}

async function getSubscription(sb, subscriptionId) {
  const { data } = await sb.from("subscriptions").select("*").eq("id", subscriptionId).maybeSingle();
  return data || null;
}

/** Recount completed/missed cycles from the cycle rows (never incremental). */
export async function recomputeCounts(sb, subscriptionId) {
  const { data: cycles } = await sb
    .from("subscription_cycles")
    .select("status")
    .eq("subscription_id", subscriptionId);
  const completed = (cycles || []).filter((c) => c.status === "completed").length;
  const missed = (cycles || []).filter((c) => c.status === "missed").length;
  await sb
    .from("subscriptions")
    .update({ completed_cycles_count: completed, missed_cycles_count: missed })
    .eq("id", subscriptionId);
  return { completed, missed };
}

/**
 * Price for a member's cycle booking. Member price applies only while the subscription is
 * active and no discount reset is pending; otherwise the service's full price.
 * variant: { price, vehicle_size, service: { category } }
 */
export async function resolveMemberPrice(sb, subscription, variant) {
  const fullPrice = Number(variant.price);
  const category = subscription.subscription_category || normalizePlanCategory(variant.service?.category);
  let memberPrice = null;
  if (category && subscription.frequency && variant.vehicle_size) {
    const { data } = await sb
      .from("subscription_prices")
      .select("price")
      .eq("service_category", category)
      .eq("frequency", subscription.frequency)
      .eq("vehicle_size", variant.vehicle_size)
      .maybeSingle();
    if (data && Number.isFinite(Number(data.price))) memberPrice = Number(data.price);
  }
  if (subscription.status !== "active") {
    return { base_price: fullPrice, price_mode: "full", reason: "first_service", member_price: memberPrice, full_price: fullPrice };
  }
  if (subscription.discount_reset_required) {
    return { base_price: fullPrice, price_mode: "full", reason: "missed_cycle", member_price: memberPrice, full_price: fullPrice };
  }
  if (memberPrice == null) {
    return { base_price: fullPrice, price_mode: "full", reason: "no_member_price", member_price: null, full_price: fullPrice };
  }
  return { base_price: memberPrice, price_mode: "discounted", reason: "member", member_price: memberPrice, full_price: fullPrice };
}

/** 15% pushback fee applies when a paid (non-free) pushback was used on the cycle. */
export function pushbackFeeFor(cycle, basePrice) {
  const applies = cycle.pushback_used === true && cycle.free_pushback !== true;
  return {
    pushback_fee_applied: applies,
    pushback_fee_amount: applies ? Math.round(Number(basePrice) * 0.15 * 100) / 100 : null
  };
}

/**
 * A member slot must fall on a New York date inside the cycle window (or pushback window)
 * and start at least 24 hours from now.
 */
export function validateMemberSlot(cycle, scheduledStartIso, now = new Date()) {
  const day = toNYDate(scheduledStartIso);
  const end = getEffectiveWindowEnd(cycle);
  if (!day || !end) return { ok: false, message: "Invalid appointment time." };
  if (day < cycle.window_start_date || day > end) {
    return { ok: false, message: `Please choose a date between ${cycle.window_start_date} and ${end}.` };
  }
  if (new Date(scheduledStartIso).getTime() - now.getTime() < MIN_ADVANCE_MS) {
    return { ok: false, message: "Appointments must be booked at least 24 hours in advance." };
  }
  return { ok: true };
}

/**
 * Link a booking to a cycle and move the cycle to booked (or completed when the booking is
 * already completed). Returns { ok, link } or { ok:false, conflict }.
 */
export async function linkBookingToCycle(sb, {
  subscription,
  cycle,
  bookingId,
  priceMode,
  pushbackFeeApplied = false,
  pushbackFeeAmount = null,
  adminOverride = false,
  bookingCompleted = false,
  actor = "system",
  notes = null
}) {
  const { data: link, error: linkErr } = await sb
    .from("subscription_cycle_bookings")
    .insert({
      cycle_id: cycle.id,
      booking_id: bookingId,
      price_mode: priceMode === "discounted" ? "discounted" : "full",
      pushback_fee_applied: pushbackFeeApplied,
      pushback_fee_amount: pushbackFeeAmount,
      admin_override: adminOverride
    })
    .select("*")
    .single();
  if (linkErr) {
    console.warn("[CYCLE_LINK] insert failed", { cycle_id: cycle.id, booking_id: bookingId, error: linkErr.message });
    return { ok: false, conflict: true, error: linkErr };
  }

  const update = bookingCompleted
    ? { status: "completed", completed_at: nowIso(), resolved_by: actor }
    : { status: "booked" };
  const fromStatuses = bookingCompleted ? ["open", "booked", "missed", "void"] : ["open", "missed", "void"];
  await sb.from("subscription_cycles").update(update).eq("id", cycle.id).in("status", fromStatuses);

  await audit(sb, {
    subscription_id: subscription.id,
    cycle_id: cycle.id,
    booking_id: bookingId,
    action: bookingCompleted ? "link_completed" : "link",
    actor,
    before: { status: cycle.status },
    after: { status: update.status, price_mode: link.price_mode },
    notes
  });
  console.log(bookingCompleted ? "CYCLE_COMPLETED" : "CYCLE_BOOKED", { cycle_id: cycle.id, booking_id: bookingId });
  if (bookingCompleted) await afterCycleCompleted(sb, subscription.id, link);
  return { ok: true, link };
}

async function afterCycleCompleted(sb, subscriptionId, link) {
  const sub = await getSubscription(sb, subscriptionId);
  if (sub?.discount_reset_required && link?.price_mode === "full") {
    await sb.from("subscriptions").update({ discount_reset_required: false }).eq("id", subscriptionId);
    console.log("DISCOUNT_RESTORED", { subscription_id: subscriptionId });
  }
  await recomputeCounts(sb, subscriptionId);
}

/** Free 5-business-day extension from max(effective end, today); reminders start over. */
export function extensionUpdate(cycle, today, minEnd = null) {
  const effectiveEnd = getEffectiveWindowEnd(cycle);
  const from = effectiveEnd && effectiveEnd > today ? effectiveEnd : today;
  let end = getPushbackEnd(from);
  if (minEnd && minEnd > end) end = minEnd;
  return {
    pushback_used: true,
    pushback_end_date: end,
    free_pushback: true,
    reminder_1_sent_at: null,
    reminder_2_sent_at: null
  };
}

/**
 * The linked booking was cancelled or denied: release the link and reopen the cycle.
 * When the business cancelled it, the member also gets a free 5-business-day extension.
 */
export async function onBookingCancelled(sb, bookingId, { actor = "system", businessInitiated = false, today = todayNY() } = {}) {
  const link = await getActiveLinkForBooking(sb, bookingId);
  if (!link) return { ok: true, changed: false };
  await sb.from("subscription_cycle_bookings").update({ released_at: nowIso() }).eq("id", link.id).is("released_at", null);

  const cycle = await getCycle(sb, link.cycle_id);
  if (!cycle) return { ok: true, changed: true };
  let after = { status: cycle.status };
  if (cycle.status === "booked") {
    const update = { status: "open", ...(businessInitiated ? extensionUpdate(cycle, today) : {}) };
    await sb.from("subscription_cycles").update(update).eq("id", cycle.id).eq("status", "booked");
    after = update;
  }
  await audit(sb, {
    subscription_id: cycle.subscription_id,
    cycle_id: cycle.id,
    booking_id: bookingId,
    action: businessInitiated ? "booking_cancelled_by_business" : "booking_cancelled",
    actor,
    before: { status: cycle.status, pushback_end_date: cycle.pushback_end_date },
    after
  });
  console.log("CYCLE_REOPENED", { cycle_id: cycle.id, booking_id: bookingId, businessInitiated });
  return { ok: true, changed: true, cycle_id: cycle.id };
}

/**
 * Customer reschedule check (call before writing the new time): a linked booking must stay
 * inside its cycle window.
 */
export async function validateCustomerReschedule(sb, bookingId, newStartIso) {
  const link = await getActiveLinkForBooking(sb, bookingId);
  if (!link) return { ok: true };
  const cycle = await getCycle(sb, link.cycle_id);
  if (!cycle) return { ok: true };
  const day = toNYDate(newStartIso);
  const end = getEffectiveWindowEnd(cycle);
  if (day < cycle.window_start_date || day > end) {
    return {
      ok: false,
      message: `This is a maintenance plan appointment. Please choose a date between ${cycle.window_start_date} and ${end}.`
    };
  }
  return { ok: true };
}

/**
 * Admin moved a linked booking. Always allowed; if it now falls after the window, the cycle
 * gets a free extension that covers the new date so it is never marked missed.
 */
export async function onAdminReschedule(sb, bookingId, newStartIso, { actor = "admin", today = todayNY() } = {}) {
  const link = await getActiveLinkForBooking(sb, bookingId);
  if (!link) return { ok: true, changed: false };
  const cycle = await getCycle(sb, link.cycle_id);
  if (!cycle) return { ok: true, changed: false };
  const day = toNYDate(newStartIso);
  const end = getEffectiveWindowEnd(cycle);
  const outside = day < cycle.window_start_date || day > end;
  if (!outside) return { ok: true, changed: false };

  await sb.from("subscription_cycle_bookings").update({ admin_override: true }).eq("id", link.id);
  const update = day > end ? extensionUpdate(cycle, today, day) : {};
  if (Object.keys(update).length) {
    await sb.from("subscription_cycles").update(update).eq("id", cycle.id);
  }
  await audit(sb, {
    subscription_id: cycle.subscription_id,
    cycle_id: cycle.id,
    booking_id: bookingId,
    action: "admin_reschedule_outside_window",
    actor,
    before: { window_end: end },
    after: { new_date: day, ...update }
  });
  return { ok: true, changed: true };
}

/**
 * First completed service: activate the subscription, anchor it to the New York date of that
 * service, and record it as completed cycle 0 (it counts toward the 3-cycle commitment).
 */
export async function activateSubscription(sb, subscription, booking, { actor = "admin" } = {}) {
  const anchor = toNYDate(booking.scheduled_start);
  const { data: updated } = await sb
    .from("subscriptions")
    .update({
      status: "active",
      anchor_date: anchor,
      anchor_index_base: 0,
      activation_completed_at: nowIso()
    })
    .eq("id", subscription.id)
    .eq("status", "pending_activation")
    .select("id");
  if (!updated || updated.length === 0) return { ok: true, changed: false };

  const { data: cycle0 } = await sb
    .from("subscription_cycles")
    .insert({
      subscription_id: subscription.id,
      cycle_index: 0,
      status: "completed",
      window_start_date: anchor,
      window_end_date: anchor,
      opens_on: anchor,
      pushback_used: false,
      completed_at: nowIso(),
      resolved_by: "activation"
    })
    .select("*")
    .single();
  if (cycle0) {
    await sb.from("subscription_cycle_bookings").insert({
      cycle_id: cycle0.id,
      booking_id: booking.id,
      price_mode: "full",
      pushback_fee_applied: false
    });
  }
  await recomputeCounts(sb, subscription.id);
  await audit(sb, {
    subscription_id: subscription.id,
    cycle_id: cycle0?.id,
    booking_id: booking.id,
    action: "activate",
    actor,
    after: { status: "active", anchor_date: anchor }
  });
  console.log("SUBSCRIPTION_ACTIVATED", { subscription_id: subscription.id, anchor_date: anchor });
  return { ok: true, changed: true, anchor_date: anchor };
}

/**
 * A booking was marked completed: activate a pending subscription, or complete the linked
 * cycle. Unlinked bookings that clearly belong to a member's open cycle are linked first.
 */
export async function onBookingCompleted(sb, bookingId, { actor = "admin" } = {}) {
  const { data: booking } = await sb
    .from("bookings")
    .select("id, customer_id, vehicle_id, scheduled_start, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return { ok: false, message: "Booking not found" };

  const { data: activationSub } = await sb
    .from("subscriptions")
    .select("*")
    .eq("activation_booking_id", bookingId)
    .maybeSingle();
  if (activationSub && activationSub.status === "pending_activation") {
    return activateSubscription(sb, activationSub, booking, { actor });
  }
  if (activationSub) return { ok: true, changed: false };

  const link = await getActiveLinkForBooking(sb, bookingId);
  if (link) {
    const cycle = await getCycle(sb, link.cycle_id);
    if (!cycle || cycle.status === "completed") return { ok: true, changed: false };
    await sb
      .from("subscription_cycles")
      .update({ status: "completed", completed_at: nowIso(), resolved_by: actor })
      .eq("id", cycle.id)
      .in("status", ["open", "booked", "missed", "void"]);
    await audit(sb, {
      subscription_id: cycle.subscription_id,
      cycle_id: cycle.id,
      booking_id: bookingId,
      action: "complete",
      actor,
      before: { status: cycle.status },
      after: { status: "completed" }
    });
    console.log("CYCLE_COMPLETED", { cycle_id: cycle.id, booking_id: bookingId });
    await afterCycleCompleted(sb, cycle.subscription_id, link);
    return { ok: true, changed: true, cycle_id: cycle.id };
  }

  const match = await findCycleForBooking(sb, booking, { statuses: ["open"] });
  if (!match) return { ok: true, changed: false };
  const price = await priceModeForExistingBooking(sb, match.subscription, bookingId);
  return linkBookingToCycle(sb, {
    subscription: match.subscription,
    cycle: match.cycle,
    bookingId,
    priceMode: price,
    bookingCompleted: true,
    actor,
    notes: "auto-linked on completion"
  });
}

export async function priceModeForExistingBooking(sb, subscription, bookingId) {
  if (subscription.status !== "active" || subscription.discount_reset_required) return "full";
  const { data: booking } = await sb
    .from("bookings")
    .select("base_price, service_variant_id")
    .eq("id", bookingId)
    .maybeSingle();
  const { data: variant } = booking?.service_variant_id
    ? await sb.from("service_variants").select("price").eq("id", booking.service_variant_id).maybeSingle()
    : { data: null };
  if (booking && variant && Number(booking.base_price) < Number(variant.price)) return "discounted";
  return "full";
}

function vehicleKey(v) {
  if (!v) return null;
  const plate = String(v.license_plate || "").replace(/\s+/g, "").toUpperCase();
  if (plate) return `plate:${plate}`;
  const mm = `${v.vehicle_make || ""} ${v.vehicle_model || ""}`.trim().toLowerCase();
  return mm ? `mm:${mm}` : null;
}

/**
 * Find the member cycle a booking belongs to: same customer, booking date inside the cycle's
 * window (or pushback window). With several subscriptions, the vehicle must match.
 */
export async function findCycleForBooking(sb, booking, { statuses = ["open"] } = {}) {
  const { data: subs } = await sb
    .from("subscriptions")
    .select("*")
    .eq("customer_id", booking.customer_id)
    .eq("status", "active");
  if (!subs || subs.length === 0) return null;

  const day = toNYDate(booking.scheduled_start);
  let candidates = [];
  for (const sub of subs) {
    const { data: cycles } = await sb
      .from("subscription_cycles")
      .select("*")
      .eq("subscription_id", sub.id)
      .in("status", statuses);
    for (const cycle of cycles || []) {
      if (cycle.cycle_index === 0) continue;
      const end = getEffectiveWindowEnd(cycle);
      if (day >= cycle.window_start_date && day <= end) candidates.push({ subscription: sub, cycle });
    }
  }
  if (candidates.length > 1) {
    const ids = [booking.vehicle_id, ...candidates.map((c) => c.subscription.vehicle_id)].filter(Boolean);
    const { data: vehicles } = await sb
      .from("vehicles")
      .select("id, license_plate, vehicle_make, vehicle_model")
      .in("id", ids);
    const byId = new Map((vehicles || []).map((v) => [v.id, v]));
    const bookingKey = vehicleKey(byId.get(booking.vehicle_id));
    candidates = candidates.filter((c) =>
      c.subscription.vehicle_id === booking.vehicle_id ||
      (bookingKey && vehicleKey(byId.get(c.subscription.vehicle_id)) === bookingKey)
    );
  }
  if (candidates.length !== 1) return null;
  const linked = await getActiveLinkForBooking(sb, booking.id);
  return linked ? null : candidates[0];
}

/**
 * Safety net before marking a cycle missed: a booking by the same customer inside the window
 * that was never linked. Prefers completed, then confirmed, then pending.
 */
export async function findUnlinkedMatchingBooking(sb, subscription, cycle) {
  const end = getEffectiveWindowEnd(cycle);
  const fromTs = `${cycle.window_start_date}T00:00:00-05:00`;
  const toTs = `${end}T23:59:59-04:00`;
  const { data: bookings } = await sb
    .from("bookings")
    .select("id, customer_id, vehicle_id, scheduled_start, status")
    .eq("customer_id", subscription.customer_id)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .gte("scheduled_start", new Date(Date.parse(fromTs) - 12 * 3600e3).toISOString())
    .lte("scheduled_start", new Date(Date.parse(toTs) + 12 * 3600e3).toISOString());
  const rank = { completed: 0, confirmed: 1, reschedule_requested: 2, pending: 3 };
  const inWindow = (bookings || [])
    .filter((b) => b.id !== subscription.activation_booking_id)
    .filter((b) => {
      const day = toNYDate(b.scheduled_start);
      return day >= cycle.window_start_date && day <= end;
    })
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  for (const b of inWindow) {
    const match = await findCycleForBooking(sb, b, { statuses: [cycle.status] });
    if (match && match.cycle.id === cycle.id) return b;
  }
  return null;
}

/** Window ended with no booking: mark missed (once), reset discount, recount. */
export async function markCycleMissed(sb, subscription, cycle, { actor = "cron" } = {}) {
  const { data: updated } = await sb
    .from("subscription_cycles")
    .update({ status: "missed", missed_at: nowIso(), resolved_by: actor })
    .eq("id", cycle.id)
    .eq("status", "open")
    .select("id");
  if (!updated || updated.length === 0) return { ok: true, changed: false };
  await sb.from("subscriptions").update({ discount_reset_required: true }).eq("id", subscription.id);
  await recomputeCounts(sb, subscription.id);
  await audit(sb, {
    subscription_id: subscription.id,
    cycle_id: cycle.id,
    action: "missed",
    actor,
    before: { status: "open" },
    after: { status: "missed", discount_reset_required: true }
  });
  console.log("CYCLE_MISSED", { cycle_id: cycle.id, subscription_id: subscription.id });
  console.log("DISCOUNT_RESET_TRIGGERED", { subscription_id: subscription.id });
  return { ok: true, changed: true };
}

/** Pause/cancel: open cycles without a booking are voided (no penalty, no more emails). */
export async function voidOpenCycles(sb, subscriptionId, { actor = "system", reason = null } = {}) {
  const { data: cycles } = await sb
    .from("subscription_cycles")
    .select("*")
    .eq("subscription_id", subscriptionId)
    .eq("status", "open");
  let voided = 0;
  for (const cycle of cycles || []) {
    if (await getActiveLinkForCycle(sb, cycle.id)) continue;
    const { data: updated } = await sb
      .from("subscription_cycles")
      .update({ status: "void", resolved_by: actor })
      .eq("id", cycle.id)
      .eq("status", "open")
      .select("id");
    if (updated?.length) {
      voided += 1;
      await audit(sb, {
        subscription_id: subscriptionId,
        cycle_id: cycle.id,
        action: "void",
        actor,
        before: { status: "open" },
        after: { status: "void" },
        notes: reason
      });
    }
  }
  return { ok: true, voided };
}

/**
 * Resume a paused subscription: re-anchor to `today` so the next window is one cadence period
 * from now instead of in the past.
 */
export async function resumeSubscription(sb, subscription, { actor = "admin", today = todayNY() } = {}) {
  const { data: maxRow } = await sb
    .from("subscription_cycles")
    .select("cycle_index")
    .eq("subscription_id", subscription.id)
    .order("cycle_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = maxRow?.cycle_index ?? 0;
  const update = { status: "active", anchor_date: today, anchor_index_base: base };
  await sb.from("subscriptions").update(update).eq("id", subscription.id);
  await audit(sb, {
    subscription_id: subscription.id,
    action: "resume",
    actor,
    before: { status: subscription.status, anchor_date: subscription.anchor_date, anchor_index_base: subscription.anchor_index_base },
    after: update
  });
  return { ok: true, next_window: computeCycleWindow(today, subscription.frequency, base + 1, base) };
}
