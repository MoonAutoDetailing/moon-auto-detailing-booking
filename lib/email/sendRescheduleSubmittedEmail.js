import { sendBookingEmail } from "../../api/_sendEmail.js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { buildManageUrl, pricingBlockHtml } from "./_shared.js";

export async function sendRescheduleSubmittedEmailCore({
  email,
  fullName,
  newStart,
  newEnd,
  manageToken,
  serviceLabel,
  price
}) {

  const firstName = (fullName || "").split(" ")[0] || "there";

  const timeRange = formatBookingTimeRange(newStart, newEnd);
  const manageUrl = manageToken ? buildManageUrl(manageToken) : null;
  const pricingHtml = pricingBlockHtml({ serviceLabel, price });

  await sendBookingEmail({
    to: email,
    subject: "Your new detailing time was received",
    html: `
      <p>Hi ${firstName},</p>

      <p>We received your new requested appointment time.</p>

      <p><b>Requested time:</b> ${timeRange}</p>

      ${pricingHtml}

      ${manageUrl ? `<p><b>Manage booking:</b> <a href=\"${manageUrl}\">${manageUrl}</a></p>` : ""}

      <p>Our team will review availability and confirm your appointment shortly.</p>

      <p>You will receive another email once your new time is officially confirmed.</p>

      <p>Moon Auto Detailing</p>
    `
  });
}
