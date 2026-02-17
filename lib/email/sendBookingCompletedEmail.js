import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingCompletedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data } = await supabase
    .from("bookings")
    .select(`customers(full_name,email)`)
    .eq("id", bookingId)
    .single();

  const firstName = data.customers.full_name.split(" ")[0];

  await sendBookingEmail({
    to: data.customers.email,
    subject: "Thank you for choosing Moon Auto Detailing",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your detailing service is complete. Thank you for trusting us with your vehicle.</p>

      <p>Check out our monthly detailing plans:</p>
      <p><a href="https://moonautodetailing.com/monthly-detailing-service">
        Monthly Detailing Service
      </a></p>

      <p>If you enjoyed the service, we would truly appreciate a review:</p>
      <p><a href="https://g.page/r/Cf7sALGmq14REAE/review">
        Leave a Review
      </a></p>

      <p>Moon Auto Detailing</p>
    `
  });
}
