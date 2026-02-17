import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    // Fetch booking + customer
    const { data: booking, error } = await supabase
      .from("bookings")
      .select(`
        id,
        manage_token,
        customers (
          full_name,
          email
        )
      `)
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const firstName = booking.customers.full_name.split(" ")[0];

    const rebookingLink =
      "https://moon-auto-detailing-booking.vercel.app/index.html?reschedule_token=" +
      booking.manage_token;

    await sendBookingEmail({
  to: booking.customers.email,
  subject: "Choose a new time for your detailing appointment",
  html: `
    <p>Hi ${firstName},</p>
    <p>Your appointment is ready to be rescheduled.</p>
    <p>Please choose a new time using the link below:</p>
    <p><a href="${rebookingLink}">${rebookingLink}</a></p>
    <p>Your service details are already saved — you only need to pick a new date and time.</p>
    <p>Moon Auto Detailing</p>
  `
});
        <p>Hi ${firstName},</p>
        <p>Your appointment is ready to be rescheduled.</p>
        <p>Please choose a new time using the link below:</p>
        <p><a href="${rebookingLink}">${rebookingLink}</a></p>
        <p>Your service details are already saved — you only need to pick a new date and time.</p>
        <p>Moon Auto Detailing</p>
      `
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
