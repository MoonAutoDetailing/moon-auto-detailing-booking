// Forgot-password links for team logins. The emailed token is random; only its SHA-256 is
// stored, it lasts one hour and works once.
import crypto from "crypto";

export const RESET_MINUTES = 60;

export function newResetToken(now = Date.now()) {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: hashResetToken(token), expires_at: new Date(now + RESET_MINUTES * 60000).toISOString() };
}

export function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function isResetToken(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function renderResetEmail(staff, link) {
  const first = staff.full_name?.split(" ")[0] || "there";
  return {
    subject: "Reset your Moon Auto Detailing password",
    html: `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430;">
    <h2 style="color:#4f95cf;margin:0 0 12px;">Hi ${esc(first)}, reset your password</h2>
    <p style="font-size:15px;">Someone (hopefully you) asked to reset the password for your team login. The link works once and expires in ${RESET_MINUTES} minutes.</p>
    <p style="margin:20px 0;"><a href="${esc(link)}" style="background:#4f95cf;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold;">Choose a new password</a></p>
    <p style="color:#7a8696;font-size:13px;">If you didn't ask for this, you can ignore this email — your password stays the same.</p>
  </div>`,
  };
}
