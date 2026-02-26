import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  console.log("admin-login: handler start");

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
    const SESSION_SECRET = requireEnv("SESSION_SECRET");

    // Safely parse JSON body (Vercel-safe)
    let body = req.body;
    if (!body || typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        body = {};
      }
    }

    const password = body.password;
    if (!password) {
      return res.status(400).json({ error: "Missing password" });
    }

    if (password !== ADMIN_PASSWORD) {
      console.log("admin-login: wrong password");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Create token (8 hour expiry)
    const expires = Date.now() + 1000 * 60 * 60 * 8;
    const payload = String(expires);

    const signature = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payload)
      .digest("hex");

    const token = `${payload}.${signature}`;

    console.log("admin-login: success");
    return res.status(200).json({ token });

  } catch (err) {
    console.error("admin-login: FATAL", err);
    return res.status(500).json({ error: "Server error" });
  }
}
