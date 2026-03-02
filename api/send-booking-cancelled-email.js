import { sendBookingCancelledEmailCore } from "../lib/email/sendBookingCancelledEmail.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const bookingId = req.body?.bookingId ?? req.body?.booking_id;

    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    await sendBookingCancelledEmailCore(bookingId);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-cancelled-email error:", err);
    return res.status(500).json({ error: "Failed to send cancelled email" });
  }
}
