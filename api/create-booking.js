import { rateLimit } from "./_rateLimit.js";
import { createBookingCore } from "./_createBookingCore.js";
import { sendBookingCreatedEmailCore } from "../lib/email/sendBookingCreatedEmail.js";
import { sendAdminNewBookingAlertEmailCore } from "../lib/email/sendAdminNewBookingAlertEmail.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const rl = rateLimit(req, {
    key: "create-booking",
    limit: 5,
    windowMs: 15 * 60 * 1000
  });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({
      ok: false,
      message: "Too many booking attempts. Please try again in a few minutes."
    });
  }

  try {
    const result = await createBookingCore({
      body: req.body || {},
      status: "pending",
      allowDiscount: true,
      allowSubscription: true
    });
    if (!result.ok) {
      return res.status(result.statusCode).json(result.body);
    }
    const booking = result.booking;

    try {
      await sendBookingCreatedEmailCore(booking.id);
    } catch (emailErr) {
      console.error("[EMAIL] type=booking-created booking_id=" + booking.id + " status=failure", emailErr);
    }

    try {
      await sendAdminNewBookingAlertEmailCore(booking.id);
      console.log("[EMAIL] type=admin-new-booking-alert booking_id=" + booking.id + " status=success");
    } catch (emailErr) {
      console.error("[EMAIL] type=admin-new-booking-alert booking_id=" + booking.id + " status=failure", emailErr);
    }

    return res.status(200).json({
      ok: true,
      bookingId: booking.id,
      manage_token: booking.manage_token
    });
  } catch (err) {
    console.error("create-booking error:", err);
    return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
  }
}
