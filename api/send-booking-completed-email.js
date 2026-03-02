import { sendBookingCompletedEmailCore } from "../lib/email/sendBookingCompletedEmail.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    await sendBookingCompletedEmailCore(bookingId);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-completed-email error:", err);
    return res.status(500).json({ error: "Failed to send completed email" });
  }
}
