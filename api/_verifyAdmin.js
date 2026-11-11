// IMPORTANT:
// This file uses DEFAULT EXPORT.
// All API routes must import like:
// import verifyAdmin from "./_verifyAdmin.js";
//
// Accepts two session formats in the x-admin-session header:
//   * v2 team tokens (api/_staffAuth.js) for owner and manager accounts — employees are rejected;
//   * the legacy shared-password token "<expires>.<sig>" (kept during the cutover to
//     individual logins; disable with LEGACY_ADMIN_LOGIN=off).
// Returns { ok: true, admin: { id, name, role } } — callers use admin.id for created_by /
// recorded_by.

import crypto from "crypto";
import { ADMIN_ROLES, isStaffToken, verifyStaff, AuthError } from "./_staffAuth.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function legacyLoginEnabled() {
  return String(process.env.LEGACY_ADMIN_LOGIN || "on").toLowerCase() !== "off";
}

function verifyLegacyToken(token) {
  const SESSION_SECRET = requireEnv("SESSION_SECRET");

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
}

export default async function verifyAdmin(req) {
  // DEV bypass for preview smoke testing
  if (process.env.VERCEL_ENV !== "production") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const bypass = url.searchParams.get("x-vercel-protection-bypass");

    if (bypass && bypass === process.env.VERCEL_PROTECTION_BYPASS) {
      return { ok: true, admin: { id: "dev-admin", name: "Dev admin", role: "owner" } };
    }
  }

  const token = req.headers["x-admin-session"];
  if (!token) throw new Error("Missing admin session");

  if (isStaffToken(token)) {
    const staff = await verifyStaff(req);
    if (!ADMIN_ROLES.includes(staff.role)) throw new AuthError("Forbidden", 403);
    return { ok: true, admin: { id: staff.id, name: staff.full_name, role: staff.role } };
  }

  if (!legacyLoginEnabled()) throw new Error("Legacy admin login disabled");
  verifyLegacyToken(token);
  return { ok: true, admin: { id: "legacy-admin", name: "Owner (shared password)", role: "owner" } };
}
