import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  // Support internal server calls (mock res has no setHeader)
  if (res?.setHeader) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res?.status ? res.status(405).end() : null;
  }


  try {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ message: "Missing booking_id" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking, error } = await supabase
      .from("bookings")
      .select(`
        scheduled_start,
        scheduled_end,
        service_address,
        customers:customer_id ( full_name, email )
      `)
      .eq("id", booking_id)
      .single();

    if (error || !booking) {
      console.error("Booking lookup failed:", error);
      return res.status(404).json({ message: "Booking not found" });
    }

    await sendBookingEmail({
      to: booking.customers.email,
      subject: "Moon Auto Detailing — Booking Confirmed",
      html: `
        <h2>Your detailing appointment is confirmed</h2>
        <p>Hi ${booking.customers.full_name},</p>
        <p>Your appointment has been confirmed.</p>
        <p><b>Start:</b> ${new Date(booking.scheduled_start).toLocaleString()}</p>
        <p><b>End:</b> ${new Date(booking.scheduled_end).toLocaleString()}</p>
        <p><b>Address:</b> ${booking.service_address}</p>
        <p>We look forward to servicing your vehicle.</p>
      `
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("send-booking-confirmed-email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
