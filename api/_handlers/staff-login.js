import { rateLimit } from "../_rateLimit.js";
import {
  serviceClient,
  signStaffToken,
  verifySecret,
  parseBody,
  STAFF_PUBLIC_COLUMNS,
} from "../_staffAuth.js";

/** POST { email, password } → { token, expires_at, staff }. Same error for every failure. */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const limit = rateLimit(req, { key: "staff-login", limit: 10, windowMs: 15 * 60 * 1000 });
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const body = parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const sb = serviceClient();
    const { data: staff, error } = await sb
      .from("staff")
      .select(`${STAFF_PUBLIC_COLUMNS}, password_hash`)
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;

    if (!staff || !staff.active || !verifySecret(password, staff.password_hash)) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    await sb.from("staff").update({ last_login_at: new Date().toISOString() }).eq("id", staff.id);

    const { password_hash: _omit, ...publicStaff } = staff;
    const { token, expires_at } = signStaffToken(staff);
    return res.status(200).json({ token, expires_at, staff: publicStaff });
  } catch (err) {
    console.error("staff-login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
