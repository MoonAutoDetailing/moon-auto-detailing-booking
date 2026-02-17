import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingRescheduledEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data } = await supabase
    .from("bookings")
    .select(`scheduled_start, customers(full_name,email)`)
    .eq("id", bookingId)
    .single();

  const firstName = data.customers.full_name.split(" ")[0];

  const date = new Date(data.scheduled_start)
    .toLocaleString("en-US", { timeZone: "America/New_York" });

  await sendBookingEmail({
    to: data.customers.email,
    subject: "Your appointment has been rescheduled",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your new appointment time is:</p>
      <p><strong>${date}</strong></p>
      <p>We look forward to seeing you.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
