import { sendBookingEmail } from "../../api/_sendEmail.js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { buildManageUrl, pricingBlockHtml, formatServiceName } from "./_shared.js";

export async function sendBookingConfirmedEmailCore({
  email,
  fullName,
  start,
  end,
  address,
  manageToken,
  data,
  price,
  basePrice,
  travelFee,
  totalPrice,
  discountCode,
  discountPercent,
  discountAmount
}) {
  const serviceLabel = formatServiceName(data);
  const timeRange = formatBookingTimeRange(start, end);

  const manageUrl = manageToken ? buildManageUrl(manageToken) : null;
  const pricingHtml = pricingBlockHtml({
    serviceLabel,
    price: price ?? null,
    basePrice: basePrice ?? null,
    travelFee: travelFee ?? null,
    totalPrice: totalPrice ?? null,
    discountCode: discountCode ?? null,
    discountPercent: discountPercent ?? null,
    discountAmount: discountAmount ?? null
  });

  const emailResult = await sendBookingEmail({
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
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  return emailResult;
}
