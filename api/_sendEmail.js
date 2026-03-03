import { Resend } from "resend";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const resend = new Resend(requireEnv("RESEND_API_KEY"));

export async function sendBookingEmail({ to, subject, html }) {
  try {
    const cleanHtml = String(html || "").trim();
    const text = cleanHtml
      .replace(/<\/(p|div|br)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const result = await resend.emails.send({
      from: "Moon Auto Detailing <bookings@moonautodetailing.com>",
      to,
      subject,
      html: cleanHtml,
      text
    });

    return { success: true, id: result?.data?.id ?? null };
  } catch (err) {
    return { success: false, error: err };
  }
}
