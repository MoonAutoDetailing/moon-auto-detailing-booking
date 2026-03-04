import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatServiceName, pricingBlockHtml } from "./_shared.js";

export async function sendBookingDeniedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Fetch booking + customer + pricing context
  const { data, error } = await supabase
    .from("bookings")
    .select(`
      base_price,
      travel_fee,
      total_price,
      customers:customer_id ( full_name, email ),
      service_variant:service_variants (
  price,
  service:services (category, level)
)
    `)
    .eq("id", bookingId)
    .single();

  if (error || !data?.customers?.email) {
    throw new Error("Denied email: booking/customer lookup failed");
  }

  const firstName = data.customers?.full_name?.split(" ")[0] ?? "there";
  const serviceLabel = formatServiceName(data);
const pricingHtml = pricingBlockHtml({
    serviceLabel,
    price: data.service_variant?.price,
    basePrice: data.base_price ?? null,
    travelFee: data.travel_fee ?? null,
    totalPrice: data.total_price ?? null
  });

  // STEP 3 — send email
  const emailResult = await sendBookingEmail({
    to: data.customers?.email,
    subject: "Booking request update",
    html: `
      <p>Hi ${firstName},</p>
      <p>Unfortunately we cannot accommodate the requested appointment time.</p>
      ${pricingHtml}
      <p>Please feel free to submit a new booking request anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  console.log("Denied email sent to", data.customers.email);
  return emailResult;
}
