/**
 * Nightly maintenance-cycle jobs. Each takes { sb, today, send } so tests can inject a fake
 * database, a fixed New York date, and an email spy. All jobs are safe to run repeatedly:
 * rows are created/changed only from the expected state and every email is sent at most once
 * (the *_sent_at stamp is written only after a successful send).
 *
 * send = { cycleOpen(cycleId), reminder1(cycleId), reminder2(cycleId), missed(cycleId) }
 */
import {
  computeCycleWindow,
  getEffectiveWindowEnd,
  getBookingOpensDate,
  getReminderDates
} from "./lifecycle.js";
import {
  audit,
  findUnlinkedMatchingBooking,
  getActiveLinkForCycle,
  linkBookingToCycle,
  markCycleMissed,
  voidOpenCycles
} from "./cycleState.js";

const MAX_INDEX_SKIP = 400;
const nowIso = () => new Date().toISOString();

async function trySend(fn, cycleId, label) {
  try {
    await fn(cycleId);
    console.log(`[EMAIL] type=${label} cycle_id=${cycleId} status=success`);
    return true;
  } catch (err) {
    console.error(`[EMAIL] type=${label} cycle_id=${cycleId} status=failure`, err?.message || err);
    return false;
  }
}

async function loadSubscriptionsById(sb, ids) {
  if (!ids.length) return new Map();
  const { data } = await sb.from("subscriptions").select("*").in("id", ids);
  return new Map((data || []).map((s) => [s.id, s]));
}

/** Apply a plan change queued for "next cycle": new plan, re-anchored at the last window. */
async function applyPendingPlanChange(sb, sub, lastCycle) {
  if (!sub.pending_frequency && !sub.pending_service_variant_id) return sub;
  const update = {
    frequency: sub.pending_frequency || sub.frequency,
    service_variant_id: sub.pending_service_variant_id || sub.service_variant_id,
    pending_frequency: null,
    pending_service_variant_id: null
  };
  if (update.frequency !== sub.frequency && lastCycle) {
    update.anchor_date = lastCycle.window_start_date;
    update.anchor_index_base = lastCycle.cycle_index;
  }
  await sb.from("subscriptions").update(update).eq("id", sub.id);
  await audit(sb, { subscription_id: sub.id, action: "plan_change_applied", actor: "cron", before: { frequency: sub.frequency, service_variant_id: sub.service_variant_id }, after: update });
  return { ...sub, ...update };
}

/**
 * Create each active subscription's next cycle once its booking-opens date arrives
 * (7 days before the window) and send the "book now" email once. Never back-fills windows
 * that are already over.
 */
export async function runGenerateCycles({ sb, today, send }) {
  const { data: subs } = await sb.from("subscriptions").select("*").eq("status", "active");
  const result = { generated: 0, opened_emails: 0, skipped_past: 0 };

  for (let sub of subs || []) {
    if (!sub.anchor_date) continue;
    const { data: cycles } = await sb
      .from("subscription_cycles")
      .select("*")
      .eq("subscription_id", sub.id)
      .order("cycle_index", { ascending: false });
    const all = cycles || [];
    let openCycle = all.find((c) => c.status === "open" || c.status === "booked");

    if (!openCycle) {
      sub = await applyPendingPlanChange(sb, sub, all[0]);
      let index = (all[0]?.cycle_index ?? 0) + 1;
      let win = computeCycleWindow(sub.anchor_date, sub.frequency, index, sub.anchor_index_base || 0);
      let guard = 0;
      while (win && win.end < today && guard < MAX_INDEX_SKIP) {
        index += 1;
        guard += 1;
        win = computeCycleWindow(sub.anchor_date, sub.frequency, index, sub.anchor_index_base || 0);
      }
      if (guard) {
        result.skipped_past += guard;
        console.log("[CYCLE_GENERATOR] skipped past windows", { subscription_id: sub.id, skipped: guard });
      }
      if (!win || today < win.opensOn) continue;

      const { data: inserted, error } = await sb
        .from("subscription_cycles")
        .insert({
          subscription_id: sub.id,
          cycle_index: index,
          status: "open",
          window_start_date: win.start,
          window_end_date: win.end,
          opens_on: win.opensOn,
          pushback_used: false
        })
        .select("*")
        .single();
      if (error || !inserted) {
        console.warn("[CYCLE_GENERATOR] insert skipped", { subscription_id: sub.id, index, error: error?.message });
        continue;
      }
      console.log("CYCLE_GENERATED", { subscription_id: sub.id, cycle_id: inserted.id, cycle_index: index, ...win });
      result.generated += 1;
      openCycle = inserted;
    }

    // "Book now" email: once per cycle, only while it's open (not booked) and booking has opened.
    const opensOn = openCycle.opens_on || getBookingOpensDate(openCycle.window_start_date);
    if (
      openCycle.status === "open" &&
      !openCycle.open_email_sent_at &&
      today >= opensOn &&
      today <= getEffectiveWindowEnd(openCycle) &&
      !(await getActiveLinkForCycle(sb, openCycle.id))
    ) {
      if (await trySend(send.cycleOpen, openCycle.id, "cycle-open")) {
        await sb.from("subscription_cycles").update({ open_email_sent_at: nowIso() }).eq("id", openCycle.id).is("open_email_sent_at", null);
        result.opened_emails += 1;
      }
    }
  }
  return result;
}

/**
 * Before acting on an open cycle, link any real booking the member made in the window
 * that never got attached. Returns true if the cycle is now handled.
 */
async function linkStrayBooking(sb, sub, cycle) {
  const booking = await findUnlinkedMatchingBooking(sb, sub, cycle);
  if (!booking) return false;
  const res = await linkBookingToCycle(sb, {
    subscription: sub,
    cycle,
    bookingId: booking.id,
    priceMode: sub.discount_reset_required ? "full" : "discounted",
    bookingCompleted: booking.status === "completed",
    actor: "cron",
    notes: "auto-linked unlinked booking found in window"
  });
  return res.ok;
}

/**
 * Open cycles whose window (or pushback window) has ended: link a stray booking if one exists,
 * otherwise mark missed once and email once. Cycles of paused/cancelled subscriptions are voided.
 * Booked cycles are never marked missed.
 */
export async function runCheckMissedCycles({ sb, today, send }) {
  const { data: openCycles } = await sb.from("subscription_cycles").select("*").eq("status", "open");
  const subs = await loadSubscriptionsById(sb, [...new Set((openCycles || []).map((c) => c.subscription_id))]);
  const result = { marked: 0, linked: 0, voided: 0, missed_emails: 0 };

  for (const cycle of openCycles || []) {
    const sub = subs.get(cycle.subscription_id);
    if (!sub) continue;
    if (sub.status !== "active") {
      const v = await voidOpenCycles(sb, sub.id, { actor: "cron", reason: `subscription ${sub.status}` });
      result.voided += v.voided;
      continue;
    }
    const end = getEffectiveWindowEnd(cycle);
    if (!end || today <= end) continue;
    if (await getActiveLinkForCycle(sb, cycle.id)) continue;

    if (await linkStrayBooking(sb, sub, cycle)) {
      result.linked += 1;
      continue;
    }
    const missed = await markCycleMissed(sb, sub, cycle, { actor: "cron" });
    if (!missed.changed) continue;
    result.marked += 1;
    if (await trySend(send.missed, cycle.id, "missed-cycle")) {
      await sb.from("subscription_cycles").update({ missed_email_sent_at: nowIso() }).eq("id", cycle.id).is("missed_email_sent_at", null);
      result.missed_emails += 1;
    }
  }
  return result;
}

/**
 * Reminders for open, unbooked cycles of active subscriptions: reminder 1 three days before the
 * (effective) window end, reminder 2 the day before. Each is sent once; if both are due on the
 * same day only the final reminder goes out.
 */
export async function runSendReminders({ sb, today, send }) {
  const { data: openCycles } = await sb.from("subscription_cycles").select("*").eq("status", "open");
  const subs = await loadSubscriptionsById(sb, [...new Set((openCycles || []).map((c) => c.subscription_id))]);
  const result = { reminder1: 0, reminder2: 0, linked: 0 };

  for (const cycle of openCycles || []) {
    const sub = subs.get(cycle.subscription_id);
    if (!sub || sub.status !== "active") continue;
    const end = getEffectiveWindowEnd(cycle);
    if (!end || today > end || today < cycle.window_start_date) continue;
    const { reminder1, reminder2 } = getReminderDates(end);
    const r2Due = today >= reminder2 && !cycle.reminder_2_sent_at;
    const r1Due = !r2Due && today >= reminder1 && !cycle.reminder_1_sent_at;
    if (!r1Due && !r2Due) continue;

    if (await getActiveLinkForCycle(sb, cycle.id)) continue;
    if (await linkStrayBooking(sb, sub, cycle)) {
      result.linked += 1;
      continue;
    }

    if (r2Due) {
      if (await trySend(send.reminder2, cycle.id, "cycle-reminder-2")) {
        await sb
          .from("subscription_cycles")
          .update({ reminder_2_sent_at: nowIso(), reminder_1_sent_at: cycle.reminder_1_sent_at || nowIso() })
          .eq("id", cycle.id);
        result.reminder2 += 1;
      }
    } else if (await trySend(send.reminder1, cycle.id, "cycle-reminder-1")) {
      await sb.from("subscription_cycles").update({ reminder_1_sent_at: nowIso() }).eq("id", cycle.id).is("reminder_1_sent_at", null);
      result.reminder1 += 1;
    }
  }
  return result;
}
