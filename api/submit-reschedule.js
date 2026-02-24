import { createClient } from "@supabase/supabase-js";
import { sendRescheduleSubmittedEmailCore } from "../lib/email/sendRescheduleSubmittedEmail.js";


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { bookingId, start, end } = req.body;

    if (!bookingId || !start || !end) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Update booking time and reset lifecycle
    const { error } = await supabase
      .from("bookings")
      .update({
        scheduled_start: start,
        scheduled_end: end,
        status: "pending",
        google_event_id: null,
        google_event_html_link: null
      })
      .eq("id", bookingId);

    if (error) {
      console.error("Reschedule update failed:", error);
      return res.status(500).json({ error: "Failed to update booking" });
    }
    // Fetch customer for notification
const { data: booking, error: bookingErr } = await supabase
  .from("bookings")
  .select(`
    manage_token,
    customers (
      full_name,
      email
    )
  `)
  .eq("id", bookingId)
  .single();

if (bookingErr || !booking) {
  console.error("Failed to load booking after reschedule:", bookingErr);
  return res.status(500).json({ error: "Failed to load booking" });
}

// Send "reschedule submitted" email (fire-and-forget)
try {
  await sendRescheduleSubmittedEmailCore({
  email: booking.customers.email,
  fullName: booking.customers.full_name,
  newStart: start,
  newEnd: end
});

} catch (err) {
  console.error("Reschedule submitted email failed:", err);
}

   return res.status(200).json({
  success: true,
  rescheduled: true,
  bookingId,
  manage_token: booking.manage_token
});

  } catch (err) {
    console.error("submit-reschedule error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
