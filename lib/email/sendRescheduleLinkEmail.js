import { sendBookingEmail } from "../../api/_sendEmail.js";
import { buildManageUrl, buildRescheduleUrl, pricingBlockHtml } from "./_shared.js";

export async function sendRescheduleLinkEmailCore({
  // Standard contract used by other cores
  email,
  fullName,
  manageToken,
  rescheduleToken,

  // Backward-compatible aliases (some callers use these)
  to,
  customerName,

  // optional
  serviceLabel,
  price
}) {
  const resolvedEmail = email || to;
  const resolvedName = fullName || customerName || "";

  if (!resolvedEmail) {
    throw new Error("sendRescheduleLinkEmailCore: missing recipient email");
  }
  if (!manageToken) {
    throw new Error("sendRescheduleLinkEmailCore: missing manageToken");
  }
  if (!rescheduleToken) {
    throw new Error("sendRescheduleLinkEmailCore: missing rescheduleToken");
  }

  const firstName = (resolvedName || "").trim().split(" ")[0] || "there";

  const rebookingLink = buildRescheduleUrl(rescheduleToken);
  const manageUrl = buildManageUrl(manageToken);
  const pricingHtml = pricingBlockHtml({ serviceLabel, price });

  const emailResult = await sendBookingEmail({
    to: resolvedEmail,
    subject: "Moon Auto Detailing — Pick a new time",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your appointment is ready to be rescheduled. Pick a new time here:</p>
      <p><a href="${rebookingLink}">${rebookingLink}</a></p>

      ${pricingHtml}

      <p style="margin-top:16px">
        Manage booking:<br/>
        <a href="${manageUrl}">${manageUrl}</a>
      </p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  return emailResult;
}
