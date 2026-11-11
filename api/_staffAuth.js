// Team logins (owner / manager / employee).
//
// Tokens: "v2.<base64url JSON payload>.<hex HMAC-SHA256>" signed with SESSION_SECRET.
// Payload: { sid, role, name, exp }. The legacy shared-password token
// ("<expires>.<sig>") is still accepted by _verifyAdmin.js during the cutover.
//
// Every request re-reads the staff row, so deactivating someone or changing their role
// takes effect immediately instead of when their token expires.

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const ROLES = ["owner", "manager", "employee"];
export const ADMIN_ROLES = ["owner", "manager"];

const SESSION_HOURS = { owner: 8, manager: 8, employee: 12 };
const SCRYPT_KEYLEN = 32;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

/* ---------------- password / PIN hashing ---------------- */

export function hashSecret(plain) {
  if (typeof plain !== "string" || !plain) throw new Error("Empty secret");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifySecret(plain, stored) {
  if (typeof plain !== "string" || !plain || typeof stored !== "string") return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(plain, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters";
  return null;
}

export function validatePin(pin) {
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) return "PIN must be 4–6 digits";
  return null;
}

/* ---------------- who may manage whom ---------------- */

/**
 * Owners manage everyone (incl. other owners and pay rates). Managers manage employees
 * only and cannot set pay rates. Nobody can deactivate or demote themselves.
 * Returns null when allowed, otherwise the reason.
 */
export function checkStaffChange(actor, target, changes) {
  const isOwner = actor.role === "owner";
  const targetRole = changes.role || target?.role;

  if (!isOwner) {
    if (actor.role !== "manager") return "Only owners and managers can manage the team";
    if (target && target.role !== "employee") return "Managers can only manage employees";
    if (targetRole !== "employee") return "Managers can only create employees";
    if (changes.hourly_rate !== undefined) return "Only the owner can set pay rates";
  }

  if (target && actor.id === target.id) {
    if (changes.active === false) return "You cannot deactivate your own account";
    if (changes.role && changes.role !== target.role) return "You cannot change your own role";
  }

  if (changes.role && !ROLES.includes(changes.role)) return "Invalid role";
  return null;
}

/* ---------------- tokens ---------------- */

function sign(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function signStaffToken(staff, { now = Date.now(), secret } = {}) {
  const key = secret || requireEnv("SESSION_SECRET");
  const hours = SESSION_HOURS[staff.role] || 8;
  const payload = {
    sid: staff.id,
    role: staff.role,
    name: staff.full_name,
    exp: now + hours * 60 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `v2.${body}`;
  return { token: `${data}.${sign(data, key)}`, expires_at: payload.exp };
}

/** Returns the payload of a valid v2 token, or throws AuthError. Does not hit the DB. */
export function parseStaffToken(token, { now = Date.now(), secret } = {}) {
  const key = secret || requireEnv("SESSION_SECRET");
  if (typeof token !== "string") throw new AuthError("Missing session");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") throw new AuthError("Invalid token format");

  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(data, key), "hex");
  const given = Buffer.from(parts[2], "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AuthError("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new AuthError("Invalid token payload");
  }
  if (!payload?.sid || !ROLES.includes(payload.role)) throw new AuthError("Invalid token payload");
  if (!payload.exp || now > payload.exp) throw new AuthError("Session expired");
  return payload;
}

export function isStaffToken(token) {
  return typeof token === "string" && token.startsWith("v2.");
}

export function getSessionToken(req) {
  return req.headers["x-staff-session"] || req.headers["x-admin-session"] || null;
}

/* ---------------- request verification ---------------- */

export function serviceClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

export const STAFF_PUBLIC_COLUMNS =
  "id, full_name, email, phone, role, hourly_rate, active, must_change_password, last_login_at, created_at";

/**
 * Verifies the session header and loads the current staff row.
 * Returns { id, full_name, email, phone, role, ... }; throws AuthError otherwise.
 */
export async function verifyStaff(req, { sb } = {}) {
  const payload = parseStaffToken(getSessionToken(req));
  const client = sb || serviceClient();
  const { data, error } = await client
    .from("staff")
    .select(STAFF_PUBLIC_COLUMNS)
    .eq("id", payload.sid)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.active) throw new AuthError("Account disabled");
  return data;
}

/** verifyStaff + role check. Throws AuthError(403) when the role is not allowed. */
export async function requireRole(req, roles, opts = {}) {
  const staff = await verifyStaff(req, opts);
  if (!roles.includes(staff.role)) throw new AuthError("Forbidden", 403);
  return staff;
}

/** Sends the right status for an auth failure; returns true when it handled the error. */
export function sendAuthError(res, err) {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.status === 403 ? "Forbidden" : "Unauthorized" });
    return true;
  }
  return false;
}

export function parseBody(req) {
  let body = req.body;
  if (!body || typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      body = {};
    }
  }
  return body;
}
