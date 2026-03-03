import { sendBookingCreatedEmailCore } from "../lib/email/sendBookingCreatedEmail.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const bookingId = req.body?.bookingId ?? req.body?.booking_id;
    if (!bookingId) return res.status(400).json({ message: "Missing bookingId" });

    await sendBookingCreatedEmailCore(bookingId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-created-email error:", err);
    if (err?.message?.includes("Booking lookup failed")) {
      return res.status(404).json({ message: "Booking not found" });
    }
    return res.status(500).json({ message: "Server error" });
  }
}
