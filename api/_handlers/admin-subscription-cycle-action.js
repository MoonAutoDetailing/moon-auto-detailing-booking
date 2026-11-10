import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd, todayNY, nextBusinessDayOnOrAfter } from "../_subscriptions/lifecycle.js";
import {
  audit,
  extensionUpdate,
  getActiveLinkForBooking,
  getActiveLinkForCycle,
  linkBookingToCycle,
  priceModeForExistingBooking,
  recomputeCounts,
  voidOpenCycles
} from "../_subscriptions/cycleState.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const nowIso = () => new Date().toISOString();

/**
 * POST { subscription_id, action, cycle_id?, booking_id?, start_date? }
 *
 * Manual maintenance-plan tools for the admin dashboard:
 *   link_booking          attach one of the member's bookings to a cycle
 *   unlink_booking        detach the booking from a cycle (cycle reopens, or is skipped if its window is over)
 *   mark_completed        cycle done without a booking on file
 *   mark_missed           window missed: cycle missed + next visit full price (no email)
 *   undo_missed           missed → skipped, and member pricing restored
 *   skip_cycle            skip an open window with no penalty
 *   grant_extension       free +5 business days on an open cycle
 *   clear_discount_reset  restore member pricing
 *   set_next_window       next window starts on start_date (re-anchors the plan)
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { subscription_id: subscriptionId, action, cycle_id: cycleId, booking_id: bookingId, start_date: startDate } = req.body || {};
  if (!subscriptionId || !action) return res.status(400).json({ error: "Missing subscription_id or action" });

  try {
    const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: sub } = await sb.from("subscriptions").select("*").eq("id", subscriptionId).maybeSingle();
    if (!sub) return res.status(404).json({ error: "Subscription not found." });

    let cycle = null;
    if (cycleId) {
      const { data } = await sb.from("subscription_cycles").select("*").eq("id", cycleId).eq("subscription_id", sub.id).maybeSingle();
      if (!data) return res.status(404).json({ error: "Cycle not found for this plan." });
      cycle = data;
    }
    const needCycle = () => {
      if (!cycle) throw Object.assign(new Error("Choose a cycle."), { status: 400 });
    };
    const today = todayNY();
    const log = (entry) => audit(sb, { subscription_id: sub.id, cycle_id: cycle?.id, actor: "admin", ...entry });

    switch (action) {
      case "link_booking": {
        needCycle();
        if (!bookingId) return res.status(400).json({ error: "Choose a booking." });
        const { data: booking } = await sb.from("bookings").select("id, customer_id, status").eq("id", bookingId).maybeSingle();
        if (!booking || booking.customer_id !== sub.customer_id) return res.status(400).json({ error: "That booking isn't this member's." });
        if (["cancelled", "denied"].includes(booking.status)) return res.status(400).json({ error: "Cancelled or denied bookings can't be attached." });
        if (await getActiveLinkForCycle(sb, cycle.id)) return res.status(400).json({ error: "This cycle already has a booking. Detach it first." });
        if (await getActiveLinkForBooking(sb, booking.id)) return res.status(400).json({ error: "That booking is already attached to another cycle." });
        const priceMode = await priceModeForExistingBooking(sb, sub, booking.id);
        const result = await linkBookingToCycle(sb, {
          subscription: sub,
          cycle,
          bookingId: booking.id,
          priceMode,
          adminOverride: true,
          bookingCompleted: booking.status === "completed",
          actor: "admin",
          notes: "attached by admin"
        });
        if (!result.ok) return res.status(409).json({ error: "Couldn't attach — this member already has another open or booked cycle." });
        return res.status(200).json({ ok: true, message: booking.status === "completed" ? "Booking attached; cycle marked completed." : "Booking attached; cycle marked booked." });
      }

      case "unlink_booking": {
        needCycle();
        const link = await getActiveLinkForCycle(sb, cycle.id);
        if (!link) return res.status(400).json({ error: "This cycle has no booking attached." });
        await sb.from("subscription_cycle_bookings").update({ released_at: nowIso() }).eq("id", link.id);
        const nextStatus = getEffectiveWindowEnd(cycle) >= today ? "open" : "void";
        const { error } = await sb.from("subscription_cycles").update({ status: nextStatus, completed_at: null, resolved_by: nextStatus === "void" ? "admin" : null }).eq("id", cycle.id);
        if (error) {
          await sb.from("subscription_cycles").update({ status: "void", resolved_by: "admin" }).eq("id", cycle.id);
        }
        await recomputeCounts(sb, sub.id);
        await log({ booking_id: link.booking_id, action: "admin_unlink", before: { status: cycle.status }, after: { status: error ? "void" : nextStatus } });
        return res.status(200).json({ ok: true, message: "Booking detached." });
      }

      case "mark_completed": {
        needCycle();
        if (cycle.status === "completed") return res.status(400).json({ error: "Already completed." });
        await sb.from("subscription_cycles").update({ status: "completed", completed_at: nowIso(), resolved_by: "admin" }).eq("id", cycle.id);
        await recomputeCounts(sb, sub.id);
        await log({ action: "admin_mark_completed", before: { status: cycle.status }, after: { status: "completed" } });
        return res.status(200).json({ ok: true, message: "Cycle marked completed." });
      }

      case "mark_missed": {
        needCycle();
        if (cycle.status !== "open") return res.status(400).json({ error: "Only open cycles without a booking can be marked missed." });
        await sb.from("subscription_cycles").update({ status: "missed", missed_at: nowIso(), resolved_by: "admin" }).eq("id", cycle.id).eq("status", "open");
        await sb.from("subscriptions").update({ discount_reset_required: true }).eq("id", sub.id);
        await recomputeCounts(sb, sub.id);
        await log({ action: "admin_mark_missed", before: { status: "open" }, after: { status: "missed", discount_reset_required: true } });
        return res.status(200).json({ ok: true, message: "Cycle marked missed. Next visit is full price." });
      }

      case "undo_missed": {
        needCycle();
        if (cycle.status !== "missed") return res.status(400).json({ error: "This cycle isn't marked missed." });
        await sb.from("subscription_cycles").update({ status: "void", resolved_by: "admin" }).eq("id", cycle.id);
        await sb.from("subscriptions").update({ discount_reset_required: false }).eq("id", sub.id);
        await recomputeCounts(sb, sub.id);
        await log({ action: "admin_undo_missed", before: { status: "missed" }, after: { status: "void", discount_reset_required: false } });
        return res.status(200).json({ ok: true, message: "Miss removed and member pricing restored." });
      }

      case "skip_cycle": {
        needCycle();
        if (cycle.status !== "open") return res.status(400).json({ error: "Only open, unbooked cycles can be skipped." });
        if (await getActiveLinkForCycle(sb, cycle.id)) return res.status(400).json({ error: "Detach the booking first." });
        await sb.from("subscription_cycles").update({ status: "void", resolved_by: "admin" }).eq("id", cycle.id).eq("status", "open");
        await log({ action: "admin_skip", before: { status: "open" }, after: { status: "void" } });
        return res.status(200).json({ ok: true, message: "Window skipped with no penalty. The next window will be created on schedule." });
      }

      case "grant_extension": {
        needCycle();
        if (cycle.status !== "open") return res.status(400).json({ error: "Only open cycles can be extended." });
        const update = extensionUpdate(cycle, today);
        await sb.from("subscription_cycles").update(update).eq("id", cycle.id);
        await log({ action: "admin_extension", before: { effective_end: getEffectiveWindowEnd(cycle) }, after: update });
        return res.status(200).json({ ok: true, message: `Window extended to ${update.pushback_end_date} at no charge.` });
      }

      case "clear_discount_reset": {
        await sb.from("subscriptions").update({ discount_reset_required: false }).eq("id", sub.id);
        await log({ action: "admin_clear_discount_reset", before: { discount_reset_required: sub.discount_reset_required }, after: { discount_reset_required: false } });
        return res.status(200).json({ ok: true, message: "Member pricing restored." });
      }

      case "set_next_window": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return res.status(400).json({ error: "Pick a start date." });
        if (sub.status !== "active") return res.status(400).json({ error: "Only active plans can be rescheduled." });
        const { data: unresolved } = await sb.from("subscription_cycles").select("id, status").eq("subscription_id", sub.id).in("status", ["open", "booked"]);
        if ((unresolved || []).some((c) => c.status === "booked")) {
          return res.status(400).json({ error: "This member has a booked window. Cancel or complete that appointment first." });
        }
        await voidOpenCycles(sb, sub.id, { actor: "admin", reason: "next window rescheduled by admin" });
        const { data: maxRow } = await sb.from("subscription_cycles").select("cycle_index").eq("subscription_id", sub.id).order("cycle_index", { ascending: false }).limit(1).maybeSingle();
        const nextIndex = (maxRow?.cycle_index ?? 0) + 1;
        const start = nextBusinessDayOnOrAfter(startDate);
        const update = { anchor_date: start, anchor_index_base: nextIndex };
        await sb.from("subscriptions").update(update).eq("id", sub.id);
        await log({ action: "admin_set_next_window", before: { anchor_date: sub.anchor_date, anchor_index_base: sub.anchor_index_base }, after: update });
        return res.status(200).json({ ok: true, message: `Next window now starts ${start}. Booking opens 7 days before.` });
      }

      default:
        return res.status(400).json({ error: "Unknown action." });
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("admin-subscription-cycle-action error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
