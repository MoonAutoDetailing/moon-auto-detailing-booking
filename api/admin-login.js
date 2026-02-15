import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
    const SESSION_SECRET = requireEnv("SESSION_SECRET");

    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: "Missing password" });
    }

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid password" });
    }

    // Create signed session token
    const expires = Date.now() + 1000 * 60 * 60 * 8; // 8 hours
    const payload = `${expires}`;

    const signature = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payload)
      .digest("hex");

    const token = `${payload}.${signature}`;

    return res.status(200).json({ token });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
