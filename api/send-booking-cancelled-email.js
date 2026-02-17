import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: "Missing booking_id" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking } = await supabase
      .from("bookings")
      .select(`customers:customer_id ( full_name, email )`)
      .eq("id", booking_id)
      .single();

    await sendBookingEmail({
      to: booking.customers.email,
      subject: "Moon Auto Detailing — Booking Cancelled",
      html: `
        <p>Hi ${booking.customers.full_name},</p>
        <p>Your appointment has been cancelled.</p>
        <p>You can book again anytime using our booking page.</p>
        <p>Moon Auto Detailing</p>
      `
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
