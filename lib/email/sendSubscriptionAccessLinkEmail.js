import { sendBookingEmail } from "../../api/_sendEmail.js";
import { buildManageSubscriptionUrl } from "./_shared.js";

/**
 * Send subscription access link email (recovery flow). Uses existing manage link.
 * @param {string} toEmail - Recipient email
 * @param {string} manageToken - Activation booking manage_token for the link
 * @param {string} [subscriptionId] - Optional subscription id for logging
 * @returns {Promise<{ success: boolean }>}
 */
export async function sendSubscriptionAccessLinkEmailCore(toEmail, manageToken, subscriptionId) {
  if (!toEmail || !manageToken) {
    throw new Error("toEmail and manageToken required for subscription access email");
  }
  const manageUrl = buildManageSubscriptionUrl(manageToken);
  const emailResult = await sendBookingEmail({
    to: toEmail,
    subject: "Moon Auto Detailing — Your subscription access link",
    html: `
      <h2>Your subscription access link</h2>
      <p>You requested a link to manage your Moon Auto Detailing subscription.</p>
      <p><a href="${manageUrl}">Open subscription portal</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `
  });
  const status = emailResult?.success ? "success" : "failure";
  console.log("[EMAIL] type=subscription-access" + (subscriptionId ? " subscription_id=" + subscriptionId : "") + " status=" + status);
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
