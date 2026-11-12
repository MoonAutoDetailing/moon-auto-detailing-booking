import { rateLimit } from "../_rateLimit.js";
import { serviceClient, parseBody, hashSecret, validatePassword, signStaffToken, STAFF_PUBLIC_COLUMNS } from "../_staffAuth.js";
import { hashResetToken, isResetToken } from "../_passwordReset.js";

/**
 * POST { token, password } → sets the new password from an emailed reset link and signs the
 * person in ({ token, expires_at, staff }, same as staff-login). The link works once.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const limit = rateLimit(req, { key: "staff-reset", limit: 10, windowMs: 15 * 60 * 1000 });
  if (!limit.allowed) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

  const body = parseBody(req);
  const invalid = { error: "This reset link is invalid or has expired. Ask for a new one." };
  if (!isResetToken(body.token)) return res.status(400).json(invalid);
  const pwError = validatePassword(body.password);
  if (pwError) return res.status(400).json({ error: pwError });

  try {
    const sb = serviceClient();
    const { data: staff, error } = await sb
      .from("staff")
      .select(`${STAFF_PUBLIC_COLUMNS}, reset_expires_at`)
      .eq("reset_token_hash", hashResetToken(body.token))
      .maybeSingle();
    if (error) throw error;
    if (!staff || !staff.active || !staff.reset_expires_at || Date.parse(staff.reset_expires_at) < Date.now()) {
      return res.status(400).json(invalid);
    }

    const now = new Date().toISOString();
    const { error: upErr } = await sb
      .from("staff")
      .update({
        password_hash: hashSecret(body.password),
        must_change_password: false,
        reset_token_hash: null,
        reset_expires_at: null,
        last_login_at: now,
        updated_at: now,
      })
      .eq("id", staff.id);
    if (upErr) throw upErr;

    const { reset_expires_at: _omit, ...publicStaff } = staff;
    const { token, expires_at } = signStaffToken(staff);
    return res.status(200).json({ token, expires_at, staff: { ...publicStaff, must_change_password: false } });
  } catch (err) {
    console.error("staff-reset-password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
