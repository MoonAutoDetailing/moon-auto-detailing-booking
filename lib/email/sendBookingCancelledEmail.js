import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendBookingCancelledEmailCore(bookingId) {
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
    subject: "Your appointment has been cancelled",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your Moon Auto Detailing appointment has been cancelled.</p>
      <p>If this was a mistake, you can book again anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
