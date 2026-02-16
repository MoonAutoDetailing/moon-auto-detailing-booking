import { Resend } from "resend";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const resend = new Resend(requireEnv("RESEND_API_KEY"));

export async function sendBookingEmail({ to, subject, html }) {
  try {
    const result = await resend.emails.send({
      from: "Moon Auto Detailing <onboarding@resend.dev>",
      to,
      subject,
      html
    });

    console.log("Email sent:", result);
  } catch (err) {
    console.error("Email send failed:", err);
  }
}
