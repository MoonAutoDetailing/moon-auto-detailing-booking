import { sendBookingEmail } from "../../api/_sendEmail.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainTextToHtml(text) {
  const safe = escapeHtml(String(text || "").trim());
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.55;color:#142033;">${safe.replace(/\n/g, "<br>")}</div>`;
}

/**
 * Send one CRM template email to a single customer (admin-initiated).
 * Mass email requires unsubscribe support — not enabled here.
 */
export async function sendCrmTemplateEmailCore({ to, subject, body, customerId }) {
  const recipient = String(to || "").trim();
  const subjectLine = String(subject || "").trim();
  const messageBody = String(body || "").trim();

  if (!recipient) throw new Error("Recipient email is required");
  if (!subjectLine) throw new Error("Subject is required");
  if (!messageBody) throw new Error("Body is required");

  const emailResult = await sendBookingEmail({
    to: recipient,
    subject: subjectLine,
    html: plainTextToHtml(messageBody)
  });

  const status = emailResult?.success ? "success" : "failure";
  console.log(`[EMAIL] type=crm_template customer_id=${customerId || "unknown"} status=${status}`);

  if (!emailResult?.success) {
    const err = emailResult?.error;
    throw new Error(err?.message || err || "Email send failed");
  }

  return {
    success: true,
    providerMessageId: emailResult.id || null
  };
}
