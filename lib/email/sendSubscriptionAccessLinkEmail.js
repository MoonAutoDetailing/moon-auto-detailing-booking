import { sendBookingEmail } from "../../api/_sendEmail.js";
import { buildManageSubscriptionUrl } from "./_shared.js";

/**
 * Send the maintenance-portal access link(s) (recovery flow). One link per plan, so members
 * with more than one vehicle can reach every plan from a single email.
 * @param {string} toEmail - Recipient email
 * @param {Array<{ subscription: { id: string }, manageToken: string, vehicleLabel?: string }>} plans
 * @returns {Promise<{ success: boolean }>}
 */
export async function sendSubscriptionAccessLinkEmailCore(toEmail, plans) {
  const list = (plans || []).filter((p) => p?.manageToken);
  if (!toEmail || !list.length) {
    throw new Error("toEmail and at least one plan required for subscription access email");
  }
  const links = list.length === 1
    ? `<p><a href="${buildManageSubscriptionUrl(list[0].manageToken)}">Open your maintenance plan</a></p>`
    : `<p>You have ${list.length} maintenance plans:</p><ul>${list
        .map((p) => `<li><a href="${buildManageSubscriptionUrl(p.manageToken)}">${p.vehicleLabel || "Maintenance plan"}</a></li>`)
        .join("")}</ul>`;
  const emailResult = await sendBookingEmail({
    to: toEmail,
    subject: "Moon Auto Detailing — Your maintenance plan link",
    html: `
      <h2>Your maintenance plan</h2>
      <p>Here's the link you asked for. From your plan page you can see your next service window, book it, and view your history.</p>
      ${links}
      <p>If you didn't request this, you can ignore this email.</p>
    `
  });
  const status = emailResult?.success ? "success" : "failure";
  console.log("[EMAIL] type=subscription-access subscription_ids=" + list.map((p) => p.subscription.id).join(",") + " status=" + status);
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
