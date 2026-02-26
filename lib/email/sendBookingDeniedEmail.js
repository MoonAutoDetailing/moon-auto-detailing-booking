import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { buildManageUrl, pricingBlockHtml } from "./_shared.js";

export async function sendBookingDeniedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Fetch booking + customer + pricing context
  const { data, error } = await supabase
    .from("bookings")
    .select(`
      manage_token,
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

  const firstName = data.customers.full_name.split(" ")[0];
  const service = data.service_variant?.service;
const serviceLabel = service ? `${service.category} Detail Level ${service.level}` : "Service";
const pricingHtml = pricingBlockHtml({ serviceLabel, price: data.service_variant?.price });
  const manageUrl = data.manage_token ? buildManageUrl(data.manage_token) : null;

  // STEP 3 — send email
  const emailResult = await sendBookingEmail({
    to: data.customers.email,
    subject: "Booking request update",
    html: `
      <p>Hi ${firstName},</p>
      <p>Unfortunately we cannot accommodate the requested appointment time.</p>
      ${pricingHtml}
      ${manageUrl ? `<p><b>Manage booking:</b> <a href=\"${manageUrl}\">${manageUrl}</a></p>` : ""}
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
}
