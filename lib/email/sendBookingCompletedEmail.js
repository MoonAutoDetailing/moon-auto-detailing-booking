import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingCompletedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from("bookings")
    .select(`
      scheduled_start,
      scheduled_end,
      service_address,
      customers!bookings_customer_id_fkey (
        full_name,
        email
      )
    `)
    .eq("id", bookingId)
    .single();

  if (error || !data?.customers) {
    throw new Error("Failed to load booking for completion email");
  }

  await sendBookingEmail({
    to: data.customers.email,
    subject: "Thank you for choosing Moon Auto Detailing",
    html: `
      <h2>Thank you for your business!</h2>
      <p>Hi ${data.customers.full_name},</p>
      <p>Your detailing service has been completed.</p>

      <p>We would love your feedback:</p>
      <p><a href="https://g.page/r/YOUR_REVIEW_LINK">Leave a Review</a></p>

      <p>Need monthly maintenance?</p>
      <p><a href="https://moon-auto-detailing-booking.vercel.app">
        Book your next detail
      </a></p>
    `
  });
}
