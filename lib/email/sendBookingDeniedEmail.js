import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingDeniedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
  .from("bookings")
  .select(`
    customers!bookings_customer_id_fkey (
      full_name,
      email
    )
  `)
  .eq("id", bookingId)
  .single();

if (error || !data?.customers) {
  throw new Error("Failed to load customer for denied email");
}

  const firstName = data.customers.full_name.split(" ")[0];

  await sendBookingEmail({
    to: data.customers.email,
    subject: "Booking request update",
    html: `
      <p>Hi ${firstName},</p>
      <p>Unfortunately we cannot accommodate the requested appointment time.</p>
      <p>Please feel free to submit a new booking request anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
