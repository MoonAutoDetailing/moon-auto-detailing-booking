import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { buildManageUrl, pricingBlockHtml } from "./_shared.js";

export async function sendBookingCancelledEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data } = await supabase
    .from("bookings")
    .select(`
      manage_token,
      customers(full_name,email),
      service_variant:service_variants (
  price,
  service:services (category, level)
)
    `)
    .eq("id", bookingId)
    .single();

  const firstName = data.customers.full_name.split(" ")[0];
  const service = data.service_variant?.service;
const serviceLabel = service ? `${service.category} Detail Level ${service.level}` : "Service";
const pricingHtml = pricingBlockHtml({ serviceLabel, price: data.service_variant?.price });
  const manageUrl = data.manage_token ? buildManageUrl(data.manage_token) : null;

  await sendBookingEmail({
    to: data.customers.email,
    subject: "Your appointment has been cancelled",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your Moon Auto Detailing appointment has been cancelled.</p>
      ${pricingHtml}
      ${manageUrl ? `<p><b>Manage booking:</b> <a href=\"${manageUrl}\">${manageUrl}</a></p>` : ""}
      <p>If this was a mistake, you can book again anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
