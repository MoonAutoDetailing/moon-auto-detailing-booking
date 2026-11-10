import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "../_rateLimit.js";
import { createBookingCore } from "../_createBookingCore.js";
import { resolveSubscriptionByToken } from "../_subscriptions/resolveSubscriptionByToken.js";
import { buildNextService } from "../_subscriptions/memberContext.js";
import { validateMemberSlot } from "../_subscriptions/cycleState.js";
import { sendBookingCreatedEmailCore } from "../../lib/email/sendBookingCreatedEmail.js";
import { sendAdminNewBookingAlertEmailCore } from "../../lib/email/sendAdminNewBookingAlertEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * POST { member_token, cycle_id, scheduled_start, scheduled_end, service_address?, customer_notes? }
 * Books a member's open maintenance cycle. Customer, vehicle, service and price come from the
 * subscription (never the browser); the slot still goes through the normal availability and
 * travel checks in createBookingCore, and the booking is attached to the cycle.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const rl = rateLimit(req, { key: "create-member-booking", limit: 6, windowMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({ ok: false, message: "Too many booking attempts. Please try again in a few minutes." });
  }

  const body = req.body || {};
  if (!body.member_token || !body.cycle_id || !body.scheduled_start || !body.scheduled_end) {
    return res.status(400).json({ ok: false, message: "Missing booking details." });
  }

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const resolved = await resolveSubscriptionByToken(supabase, body.member_token);
    if (resolved.error) return res.status(resolved.status === 404 ? 404 : 400).json({ ok: false, message: "We couldn't find your plan. Please use the link from your latest email." });

    const { subscription, activeCycle } = resolved;
    const next = await buildNextService(supabase, resolved);
    if (!activeCycle || activeCycle.id !== body.cycle_id) {
      return res.status(409).json({ ok: false, message: "Your service window has changed. Please refresh and try again." });
    }
    if (next.phase !== "bookable") {
      const msg = {
        booked: "You already have an appointment for this service window.",
        upcoming: `Booking for this window opens ${next.opens_on}.`,
        overdue: "This service window has ended."
      }[next.phase] || "This plan can't be booked right now.";
      return res.status(409).json({ ok: false, message: msg });
    }
    const slot = validateMemberSlot(activeCycle, body.scheduled_start);
    if (!slot.ok) return res.status(400).json({ ok: false, message: slot.message });

    const serviceAddress = String(body.service_address || subscription.default_address || "").trim();
    if (!serviceAddress) return res.status(400).json({ ok: false, message: "Please enter the service address." });

    const result = await createBookingCore({
      body: {
        customer_id: subscription.customer_id,
        vehicle_id: subscription.vehicle_id,
        service_variant_id: subscription.service_variant_id,
        scheduled_start: body.scheduled_start,
        scheduled_end: body.scheduled_end,
        service_address: serviceAddress,
        customer_notes: body.customer_notes
      },
      status: "pending",
      allowDiscount: false,
      allowSubscription: false,
      memberCycle: { subscription, cycle: activeCycle, price: next.price, actor: "customer" }
    });
    if (!result.ok) return res.status(result.statusCode).json(result.body);

    try {
      await sendBookingCreatedEmailCore(result.bookingId);
    } catch (emailErr) {
      console.error("[EMAIL] type=booking-created booking_id=" + result.bookingId + " status=failure", emailErr);
    }
    try {
      await sendAdminNewBookingAlertEmailCore(result.bookingId);
    } catch (emailErr) {
      console.error("[EMAIL] type=admin-new-booking-alert booking_id=" + result.bookingId + " status=failure", emailErr);
    }

    return res.status(200).json({ ok: true, bookingId: result.bookingId, manage_token: result.manage_token });
  } catch (err) {
    console.error("create-member-booking error:", err);
    return res.status(500).json({ ok: false, message: "Booking failed. Please try again." });
  }
}
