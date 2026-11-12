import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "../_verifyAdmin.js";
import { createBookingCore } from "../_createBookingCore.js";
import { confirmBookingCore } from "../_confirmBookingCore.js";
import { resolveSubscriptionById } from "../_subscriptions/resolveSubscriptionById.js";
import { buildNextService } from "../_subscriptions/memberContext.js";
import { validateMemberSlot } from "../_subscriptions/cycleState.js";
import { sendBookingCreatedEmailCore } from "../../lib/email/sendBookingCreatedEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Book a maintenance member's open window from the admin page (e.g. they texted a time).
 * POST { subscription_id, scheduled_start, service_address?, customer_notes?,
 *        manual_time?: boolean, status?: "confirmed"|"pending", send_customer_email?: boolean }
 * Customer, vehicle, service and member/full price come from the plan — same as the member's own
 * booking page — and the booking is attached to the window. A picked slot goes through the
 * availability and travel checks; manual_time skips them (like Book a customer). Unlike the
 * customer page, the 24-hour notice rule doesn't apply and the window can be booked before it
 * opens to the customer.
 */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  if (!body.subscription_id || !body.scheduled_start) {
    return res.status(400).json({ ok: false, message: "Pick a date and time." });
  }
  const status = body.status || "confirmed";
  if (!["confirmed", "pending"].includes(status)) return res.status(400).json({ ok: false, message: "Invalid status." });
  const sendCustomerEmail = body.send_customer_email !== false;
  const manualTime = body.manual_time === true;

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const resolved = await resolveSubscriptionById(supabase, body.subscription_id);
    if (resolved.error) return res.status(resolved.status || 400).json({ ok: false, message: resolved.error });
    const { subscription, activeCycle } = resolved;

    if (subscription.status !== "active") return res.status(409).json({ ok: false, message: "This plan isn't active." });
    if (!activeCycle) {
      return res.status(409).json({ ok: false, message: "There's no open service window yet. Use \"Move next window\" on the plan to start one." });
    }
    const next = await buildNextService(supabase, resolved);
    if (next.phase === "booked") return res.status(409).json({ ok: false, message: "This window already has an appointment." });

    // Window dates only (now = epoch skips the customer-facing 24-hour notice rule).
    const slot = validateMemberSlot(activeCycle, body.scheduled_start, new Date(0));
    if (!slot.ok) {
      return res.status(400).json({ ok: false, message: `${slot.message} To book outside the window, give "+5 days free" or move the window on the plan first.` });
    }

    const serviceAddress = String(body.service_address || subscription.default_address || "").trim();
    if (!serviceAddress) return res.status(400).json({ ok: false, message: "Enter the service address." });

    const { data: variant, error: vErr } = await supabase
      .from("service_variants")
      .select("duration_minutes")
      .eq("id", subscription.service_variant_id)
      .maybeSingle();
    if (vErr) throw vErr;
    const minutes = Number(variant?.duration_minutes);
    const start = new Date(body.scheduled_start);
    if (!Number.isFinite(minutes) || minutes <= 0 || Number.isNaN(start.getTime())) {
      return res.status(400).json({ ok: false, message: "The plan's service is missing a duration." });
    }
    const scheduledEnd = body.scheduled_end || new Date(start.getTime() + minutes * 60000).toISOString();

    const result = await createBookingCore({
      body: {
        customer_id: subscription.customer_id,
        vehicle_id: subscription.vehicle_id,
        service_variant_id: subscription.service_variant_id,
        scheduled_start: start.toISOString(),
        scheduled_end: scheduledEnd,
        service_address: serviceAddress,
        customer_notes: body.customer_notes,
      },
      status: "pending",
      allowDiscount: false,
      allowSubscription: false,
      allowAvailabilityOverride: manualTime,
      memberCycle: { subscription, cycle: activeCycle, price: next.price, actor: "admin", adminOverride: manualTime },
    });
    if (!result.ok) return res.status(result.statusCode).json(result.body);

    if (status === "pending") {
      if (sendCustomerEmail) {
        try { await sendBookingCreatedEmailCore(result.bookingId); }
        catch (e) { console.error("[EMAIL] type=booking-created booking_id=" + result.bookingId + " status=failure", e); }
      }
      return res.status(200).json({ ok: true, bookingId: result.bookingId, status: "pending" });
    }

    // Confirm (calendar event + confirmation email). If that fails the booking stays as a request
    // attached to the window — it is never deleted here — and can be confirmed from Bookings.
    const confirmResult = await confirmBookingCore({ bookingId: result.bookingId, sendCustomerEmail });
    if (!confirmResult.ok) {
      return res.status(200).json({
        ok: true,
        bookingId: result.bookingId,
        status: "pending",
        warning: `Booked, but confirming failed (${confirmResult.body?.message || "unknown error"}). Confirm it from Bookings → To confirm.`,
      });
    }
    return res.status(200).json({ ok: true, bookingId: result.bookingId, status: "confirmed" });
  } catch (err) {
    console.error("admin-book-member error:", err);
    return res.status(500).json({ ok: false, message: "Booking failed. Please try again." });
  }
}
