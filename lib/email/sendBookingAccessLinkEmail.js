import { sendBookingEmail } from "../../api/_sendEmail.js";
import { buildManageUrl } from "./_shared.js";

/**
 * Send booking access link email (recovery flow). Uses existing manage-booking link.
 * @param {string} toEmail - Recipient email
 * @param {string} manageToken - Booking manage_token for the link
 * @param {string} [bookingId] - Optional booking id for logging
 * @returns {Promise<{ success: boolean }>}
 */
export async function sendBookingAccessLinkEmailCore(toEmail, manageToken, bookingId) {
  if (!toEmail || !manageToken) {
    throw new Error("toEmail and manageToken required for booking access email");
  }
  const manageUrl = buildManageUrl(manageToken);
  const emailResult = await sendBookingEmail({
    to: toEmail,
    subject: "Moon Auto Detailing — Your booking access link",
    html: `
      <h2>Your booking access link</h2>
      <p>You requested a link to manage your Moon Auto Detailing booking.</p>
      <p><a href="${manageUrl}">Open booking portal</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `
  });
  const status = emailResult?.success ? "success" : "failure";
  console.log("[EMAIL] type=booking-access" + (bookingId ? " booking_id=" + bookingId : "") + " status=" + status);
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
