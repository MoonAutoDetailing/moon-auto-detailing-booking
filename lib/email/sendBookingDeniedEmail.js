import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingDeniedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // STEP 1 — get booking
  const { data: booking, error: bookingError } = await supabase
    .from("bookings")
    .select("customer_id")
    .eq("id", bookingId)
    .single();

  if (bookingError || !booking) {
    throw new Error("Denied email: booking lookup failed");
  }

  // STEP 2 — get customer separately (NO JOIN)
  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("full_name, email")
    .eq("id", booking.customer_id)
    .single();

  if (customerError || !customer) {
    throw new Error("Denied email: customer lookup failed");
  }

  const firstName = customer.full_name.split(" ")[0];

  // STEP 3 — send email
  await sendBookingEmail({
    to: customer.email,
    subject: "Booking request update",
    html: `
      <p>Hi ${firstName},</p>
      <p>Unfortunately we cannot accommodate the requested appointment time.</p>
      <p>Please feel free to submit a new booking request anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });

  console.log("Denied email sent to", customer.email);
}
