import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { buildManageSubscriptionUrl } from "./_shared.js";

/**
 * Send subscription-created email. Uses activation booking manage_token for Manage link.
 * @param {string} subscriptionId - subscriptions.id
 * @returns {Promise<{ success: boolean }>}
 */
export async function sendSubscriptionCreatedEmailCore(subscriptionId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: subscription, error: subErr } = await supabase
    .from("subscriptions")
    .select(`
      id,
      frequency,
      activation_booking_id,
      customers:customer_id ( full_name, email ),
      service_variants:service_variant_id ( id, services:service_id ( category, level ) )
    `)
    .eq("id", subscriptionId)
    .single();

  if (subErr || !subscription?.customers?.email) {
    throw new Error("Subscription or customer lookup failed for created email");
  }

  const { data: activationBooking, error: bookErr } = await supabase
    .from("bookings")
    .select("id, manage_token")
    .eq("id", subscription.activation_booking_id)
    .single();

  if (bookErr || !activationBooking?.manage_token) {
    throw new Error("Activation booking or manage_token not found for subscription email");
  }

  const customer = subscription.customers;
  const service = subscription.service_variants?.services;
  const serviceLabel = service
    ? `${service.category || "Detail"}${service.level != null ? ` Level ${service.level}` : ""}`
    : "Subscription";
  const manageUrl = buildManageSubscriptionUrl(activationBooking.manage_token);

  const emailResult = await sendBookingEmail({
    to: customer.email,
    subject: "Moon Auto Detailing — Subscription created",
    html: `
      <h2>Your subscription has been created</h2>
      <p>Hi ${(customer.full_name || "").split(" ")[0] || "there"},</p>
      <p>Your subscription has been set up successfully.</p>
      <p><b>Service:</b> ${serviceLabel}</p>
      <p><b>Frequency:</b> ${subscription.frequency || "—"}</p>
      <p>You can manage your subscription and book your next service here:</p>
      <p><a href="${manageUrl}">Manage Subscription</a></p>
    `
  });

  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
