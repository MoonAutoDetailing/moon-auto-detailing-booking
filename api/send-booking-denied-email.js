import { sendBookingDeniedEmailCore } from "../lib/email/sendBookingDeniedEmail.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { booking_id } = req.body;

    if (!booking_id) {
      return res.status(400).json({ error: "Missing booking_id" });
    }

    await sendBookingDeniedEmailCore(booking_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-denied-email error:", err);
    return res.status(500).json({ error: "Failed to send denied email" });
  }
}
