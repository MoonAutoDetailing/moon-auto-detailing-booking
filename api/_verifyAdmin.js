// IMPORTANT:
// This file uses DEFAULT EXPORT.
// All API routes must import like:
// import verifyAdmin from "./_verifyAdmin.js";


import crypto from "crypto";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default function verifyAdmin(req) {
  // DEV bypass for preview smoke testing
  if (process.env.VERCEL_ENV !== "production") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const bypass = url.searchParams.get("x-vercel-protection-bypass");

    if (bypass && bypass === process.env.VERCEL_PROTECTION_BYPASS) {
      return { ok: true, admin: { id: "dev-admin" } };
    }
  }

  const SESSION_SECRET = requireEnv("SESSION_SECRET");

  const token = req.headers["x-admin-session"];
  if (!token) throw new Error("Missing admin session");

  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format");

  const [payload, signature] = parts;

  // Recreate signature
  const expectedSig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");

  if (signature !== expectedSig) {
    throw new Error("Invalid signature");
  }

  const expires = Number(payload);
  if (!expires || Date.now() > expires) {
    throw new Error("Session expired");
  }

  return true;
}
