// Team logins: hashing, tokens, role rules, and verifyAdmin accepting owner/manager
// tokens while rejecting employees. The supabase client is swapped for the in-memory fake.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SESSION_SECRET = "test-secret";
process.env.SUPABASE_URL = "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
process.env.VERCEL_ENV = "production";

let current = createFakeSupabase();
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => current } });

const auth = await import("../api/_staffAuth.js");
const { default: verifyAdmin } = await import("../api/_verifyAdmin.js");

const owner = { id: "11111111-1111-4111-8111-111111111111", full_name: "Olivia Owner", role: "owner", active: true };
const manager = { id: "22222222-2222-4222-8222-222222222222", full_name: "Max Manager", role: "manager", active: true };
const employee = { id: "33333333-3333-4333-8333-333333333333", full_name: "Eli Employee", role: "employee", active: true };

function seed(rows = [owner, manager, employee]) {
  current = createFakeSupabase({ staff: rows.map((r) => ({ email: `${r.role}@x.com`, ...r })) });
}

const req = (token, header = "x-admin-session") => ({ url: "/api/x", headers: { host: "x", [header]: token } });

test("password hashes verify only the original secret", () => {
  const h = auth.hashSecret("correct horse");
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(auth.verifySecret("correct horse", h), true);
  assert.equal(auth.verifySecret("wrong", h), false);
  assert.equal(auth.verifySecret("correct horse", null), false);
  assert.notEqual(auth.hashSecret("same"), auth.hashSecret("same")); // salted
});

test("password and PIN validation", () => {
  assert.ok(auth.validatePassword("short"));
  assert.equal(auth.validatePassword("longenough"), null);
  assert.equal(auth.validatePin("1234"), null);
  assert.equal(auth.validatePin("123456"), null);
  assert.ok(auth.validatePin("12a4"));
  assert.ok(auth.validatePin("123"));
});

test("tokens round-trip, expire by role, and reject tampering", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const { token, expires_at } = auth.signStaffToken(employee, { now });
  assert.equal(expires_at, now + 12 * 3600 * 1000);
  const p = auth.parseStaffToken(token, { now });
  assert.equal(p.sid, employee.id);
  assert.equal(p.role, "employee");

  assert.equal(auth.signStaffToken(manager, { now }).expires_at, now + 8 * 3600 * 1000);
  assert.throws(() => auth.parseStaffToken(token, { now: expires_at + 1 }), /expired/);

  // Forge a role upgrade by re-encoding the payload with the old signature.
  const [v, body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), role: "owner" })).toString("base64url");
  assert.throws(() => auth.parseStaffToken(`${v}.${forged}.${sig}`, { now }), /signature/);
  assert.throws(() => auth.parseStaffToken(token, { now, secret: "other" }), /signature/);
  assert.throws(() => auth.parseStaffToken("123.abc", { now }), /format/);
});

test("checkStaffChange: owners manage everyone, managers only employees", () => {
  assert.equal(auth.checkStaffChange(owner, null, { role: "manager", hourly_rate: 25 }), null);
  assert.equal(auth.checkStaffChange(manager, null, { role: "employee" }), null);
  assert.match(auth.checkStaffChange(manager, null, { role: "manager" }), /only create employees/);
  assert.match(auth.checkStaffChange(manager, null, { role: "employee", hourly_rate: 20 }), /pay rates/);
  assert.match(auth.checkStaffChange(manager, owner, { full_name: "x" }), /only manage employees/);
  assert.match(auth.checkStaffChange(employee, null, { role: "employee" }), /owners and managers/);
  assert.match(auth.checkStaffChange(owner, owner, { active: false }), /deactivate your own/);
  assert.match(auth.checkStaffChange(owner, owner, { role: "manager" }), /own role/);
  assert.match(auth.checkStaffChange(owner, null, { role: "admin" }), /Invalid role/);
});

test("verifyAdmin accepts owner and manager tokens and returns their identity", async () => {
  seed();
  for (const person of [owner, manager]) {
    const { token } = auth.signStaffToken(person);
    const result = await verifyAdmin(req(token));
    assert.deepEqual(result, { ok: true, admin: { id: person.id, name: person.full_name, role: person.role } });
  }
});

test("verifyAdmin rejects employees, deactivated staff and missing sessions", async () => {
  seed([owner, manager, employee, { ...manager, id: "44444444-4444-4444-8444-444444444444", active: false, email: "gone@x.com" }]);
  await assert.rejects(verifyAdmin(req(auth.signStaffToken(employee).token)), (e) => e.status === 403);
  await assert.rejects(
    verifyAdmin(req(auth.signStaffToken({ ...manager, id: "44444444-4444-4444-8444-444444444444" }).token)),
    /disabled/
  );
  await assert.rejects(verifyAdmin(req(undefined)), /Missing/);
});

test("role changes apply immediately, not at token expiry", async () => {
  seed();
  const { token } = auth.signStaffToken(manager); // token still says "manager"
  current = createFakeSupabase({ staff: [{ ...manager, role: "employee" }] });
  await assert.rejects(verifyAdmin(req(token)), (e) => e.status === 403);
});

test("legacy shared-password tokens still work until switched off", async () => {
  seed();
  const expires = String(Date.now() + 60_000);
  const sig = crypto.createHmac("sha256", "test-secret").update(expires).digest("hex");
  const legacy = `${expires}.${sig}`;
  const result = await verifyAdmin(req(legacy));
  assert.equal(result.admin.id, "legacy-admin");
  assert.equal(result.admin.role, "owner");

  process.env.LEGACY_ADMIN_LOGIN = "off";
  try {
    await assert.rejects(verifyAdmin(req(legacy)), /disabled/);
  } finally {
    delete process.env.LEGACY_ADMIN_LOGIN;
  }
});

test("requireRole gates employee-facing endpoints", async () => {
  seed();
  const empReq = req(auth.signStaffToken(employee).token, "x-staff-session");
  assert.equal((await auth.requireRole(empReq, ["employee", "manager", "owner"])).id, employee.id);
  await assert.rejects(auth.requireRole(empReq, ["owner"]), (e) => e.status === 403);
});
