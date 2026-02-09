import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const result = await resend.emails.send({
      from: "Moon Auto Detailing <moonautodetailing@gmail.com>",
      to: ["moonautodetailing@gmail.com"], // send ONLY to yourself for now
      subject: "Resend test email ✅",
      html: "<p>This is a test email from Vercel via Resend.</p>",
    });

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error("RESEND ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}
