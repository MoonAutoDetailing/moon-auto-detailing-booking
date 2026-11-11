import {
  serviceClient,
  verifyStaff,
  verifySecret,
  hashSecret,
  validatePassword,
  sendAuthError,
  parseBody,
} from "../_staffAuth.js";

/**
 * GET  → { staff } for the signed-in team member.
 * POST { current_password, new_password } → changes their own password.
 */
export default async function handler(req, res) {
  const sb = serviceClient();
  let staff;
  try {
    staff = await verifyStaff(req, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    console.error("staff-me auth error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      return res.status(200).json({ staff });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const problem = validatePassword(body.new_password);
      if (problem) return res.status(400).json({ error: problem });

      const { data: row, error } = await sb
        .from("staff")
        .select("password_hash")
        .eq("id", staff.id)
        .single();
      if (error) throw error;
      if (!verifySecret(String(body.current_password || ""), row.password_hash)) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }

      const { error: upErr } = await sb
        .from("staff")
        .update({
          password_hash: hashSecret(body.new_password),
          must_change_password: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", staff.id);
      if (upErr) throw upErr;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("staff-me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
