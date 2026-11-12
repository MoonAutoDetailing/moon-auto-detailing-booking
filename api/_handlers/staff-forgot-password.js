import { rateLimit } from "../_rateLimit.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { newResetToken, renderResetEmail } from "../_passwordReset.js";
import { sendBookingEmail } from "../_sendEmail.js";
import { getPublicBaseUrl } from "../../lib/email/_shared.js";

/**
 * POST { email } → always { ok: true } (never reveals whether an account exists).
 * When the email belongs to an active team member, emails them a one-hour reset link.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const limit = rateLimit(req, { key: "staff-forgot", limit: 5, windowMs: 15 * 60 * 1000 });
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  }

  const email = String(parseBody(req).email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Enter the email you sign in with" });

  try {
    const sb = serviceClient();
    const { data: staff, error } = await sb.from("staff").select("id, full_name, email, active").eq("email", email).maybeSingle();
    if (error) throw error;
    if (staff?.active) {
      const { token, hash, expires_at } = newResetToken();
      const { error: upErr } = await sb.from("staff").update({ reset_token_hash: hash, reset_expires_at: expires_at }).eq("id", staff.id);
      if (upErr) throw upErr;
      const { subject, html } = renderResetEmail(staff, `${getPublicBaseUrl()}/staff-login.html?reset=${token}`);
      const sent = await sendBookingEmail({ to: staff.email, subject, html });
      if (!sent?.success) console.error("staff-forgot-password: email failed", sent?.error);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("staff-forgot-password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
