import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { buildManageUrl, pricingBlockHtml } from "./_shared.js";

export async function sendBookingCompletedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from("bookings")
    .select(`
      manage_token,
      scheduled_start,
      scheduled_end,
      service_address,
      customers!bookings_customer_id_fkey (
        full_name,
        email
      ),
      service_variant:service_variants (
  price,
  service:services (category, level)
)
    `)
    .eq("id", bookingId)
    .single();

  if (error || !data?.customers) {
    throw new Error("Failed to load booking for completion email");
  }

  const service = data.service_variants?.services;
  const serviceLabel = service ? `${service.category} Detail Level ${service.level}` : "Service";
  const pricingHtml = pricingBlockHtml({ serviceLabel, price: data.service_variants?.price });
  const manageUrl = data.manage_token ? buildManageUrl(data.manage_token) : null;

  const emailResult = await sendBookingEmail({
    to: data.customers.email,
    subject: "Thank you for choosing and trusting Moon Auto Detailing with your ride today.",
    html: `
      <h2>Thank you for your business!</h2>
      <p>Hi ${data.customers.full_name},</p>
      <p>Your detailing service has been completed.</p>

      ${pricingHtml}

      ${manageUrl ? `<p><b>Manage booking:</b> <a href=\"${manageUrl}\">${manageUrl}</a></p>` : ""}

      <p>We would love your feedback!:</p>
      <p><a href="https://g.page/r/Cf7sALGmq14REAE/review">Leave a Review</a></p>

      <p>The best way to keep your vehicle shining all year long is with our maintainance details! Check them out here.</p>
      <p><a href="https://moonautodetailing.com/monthly-detailing-service">


        -Moon Auto Detailing team
      </a></p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  return emailResult;
}
