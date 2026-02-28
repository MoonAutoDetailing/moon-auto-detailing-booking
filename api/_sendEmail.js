import { Resend } from "resend";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const resend = new Resend(requireEnv("RESEND_API_KEY"));

export async function sendBookingEmail({ to, subject, html }) {
  try {
    console.log("EMAIL PIPELINE — sendBookingEmail called with:", {
      to,
      subject,
      hasHtml: !!html
    });
    const result = await resend.emails.send({
      from: "Moon Auto Detailing <bookings@moonautodetailing.com>",
      to,
      subject,
      html
    });

    console.log("EMAIL PIPELINE — Resend raw response:", result);
    return { success: true, id: result?.data?.id ?? null };
  } catch (err) {
    console.error("Email send failed:", err);
    return { success: false, error: err };
  }
}
