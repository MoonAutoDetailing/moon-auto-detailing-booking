export default async function handler(req, res) {
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const parts = key.split(".");
    if (parts.length < 2) return res.status(200).json({ ok: false, reason: "not a JWT" });

    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    // In Supabase JWTs, the role is typically in `role`
    return res.status(200).json({
      ok: true,
      role: payload.role || null,
      iss: payload.iss || null,
      ref: payload.ref || null
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
