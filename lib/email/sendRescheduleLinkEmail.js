import { sendBookingEmail } from "../../api/_sendEmail.js";
import { buildManageUrl, buildRescheduleUrl, pricingBlockHtml } from "./_shared.js";

export async function sendRescheduleLinkEmailCore({
  email,
  fullName,
  manageToken,
  rescheduleToken,
  serviceLabel,
  price
}) {
    const firstName = (fullName || "").split(" ")[0] || "there";

    const rebookingLink = buildRescheduleUrl(rescheduleToken);
  const manageUrl = buildManageUrl(manageToken);
  const pricingHtml = pricingBlockHtml({ serviceLabel, price });

  await sendBookingEmail({
    to: email,
    subject: "Choose a new time for your detailing appointment",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your appointment is ready to be rescheduled.</p>
      <p>Please choose a new time using the link below:</p>
      <p><a href="${rebookingLink}">${rebookingLink}</a></p>
      ${pricingHtml}
      <p><b>Manage booking:</b> <a href="${manageUrl}">${manageUrl}</a></p>
      <p>Your service details are already saved — you only need to pick a new date and time.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
