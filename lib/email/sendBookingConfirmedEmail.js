import { sendBookingEmail } from "../../api/_sendEmail.js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { buildManageUrl, pricingBlockHtml } from "./_shared.js";

export async function sendBookingConfirmedEmailCore({
  email,
  fullName,
  start,
  end,
  address,
  manageToken,
  serviceLabel,
  price
}) {
  const timeRange = formatBookingTimeRange(start, end);

  const manageUrl = manageToken ? buildManageUrl(manageToken) : null;
  const pricingHtml = pricingBlockHtml({ serviceLabel, price });

await sendBookingEmail({
  to: email,
  subject: "Moon Auto Detailing — Booking Confirmed",
  html: `
    <h2>Your detailing appointment is confirmed</h2>
    <p>Hi ${fullName},</p>
    <p>Your appointment has been confirmed for:</p>
    <p><b>${timeRange}</b></p>
    <p><b>Address:</b> ${address}</p>
    ${pricingHtml}
    ${manageUrl ? `<p><b>Manage booking:</b> <a href=\"${manageUrl}\">${manageUrl}</a></p>` : ""}
    <p>We look forward to servicing your vehicle.</p>
  `
});

}
