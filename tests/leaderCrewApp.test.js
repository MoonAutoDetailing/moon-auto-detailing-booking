// Managers and the owner use the crew app too: they clock in anywhere (no PIN), employees
// still need home base or a PIN, and the owner's own time off needs no review.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SESSION_SECRET ||= "test-secret";
process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
process.env.BASE_ADDRESS = "1 Base Rd";

const staff = [
  { id: "o1", full_name: "Owner", email: "o@x.com", role: "owner", active: true },
  { id: "m1", full_name: "Manager", email: "m@x.com", role: "manager", active: true },
  { id: "e1", full_name: "Employee", email: "e@x.com", role: "employee", active: true },
];
const sb = createFakeSupabase({ staff, time_entries: [], time_off_requests: [], staff_availability: [] });
let syncs = 0;
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_routing/geocodeAddress.js", { defaultExport: async () => ({ lat: 40.0, lng: -75.0 }) });
mock.module("../api/_teamCoverage.js", {
  namedExports: {
    syncSafely: async () => { syncs++; return { ok: true }; },
    timeOffImpact: async () => ({}),
    impactWarning: () => null,
  },
});

const { default: clock } = await import("../api/_handlers/staff-clock.js");
const { default: availability } = await import("../api/_handlers/staff-availability.js");
const { signStaffToken } = await import("../api/_staffAuth.js");

function call(handler, who, body, method = "POST") {
  const s = staff.find((x) => x.id === who);
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  const req = { method, body, query: {}, headers: { "x-staff-session": signStaffToken(s).token, "x-forwarded-for": "10.0.0.1" } };
  return handler(req, res).then(() => res);
}
const awayFromBase = { lat: 40.5, lng: -75.0, accuracy: 10 }; // ~35 miles north

test("an employee away from base still needs a PIN", async () => {
  const res = await call(clock, "e1", { action: "in", ...awayFromBase });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.needs_pin, true);
});

test("an employee at base clocks in by GPS", async () => {
  const res = await call(clock, "e1", { action: "in", lat: 40.0, lng: -75.0, accuracy: 10 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_method, "gps");
});

test("a manager clocks in away from base without a PIN; location is kept", async () => {
  const res = await call(clock, "m1", { action: "in", ...awayFromBase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_method, "anywhere");
  const entry = sb.tables?.time_entries?.find?.((e) => e.staff_id === "m1")
    || (await sb.from("time_entries").select("*").eq("staff_id", "m1").single()).data;
  assert.equal(entry.verify_method, "anywhere");
  assert.ok(entry.in_distance_m > 50000);
});

test("the owner clocks in without a location or PIN", async () => {
  const res = await call(clock, "o1", { action: "in" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_method, "anywhere");
});

test("a manager's time off waits for the owner; the owner's own is approved straight away", async () => {
  const start = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const m = await call(availability, "m1", { kind: "time_off", start_date: start, end_date: start });
  assert.equal(m.statusCode, 200);
  assert.notEqual(m.body.time_off[0].status, "approved"); // left to the database default, "pending"
  assert.equal(syncs, 0);

  const o = await call(availability, "o1", { kind: "time_off", start_date: start, end_date: start });
  assert.equal(o.statusCode, 200);
  assert.equal(o.body.time_off[0].status, "approved");
  const row = (await sb.from("time_off_requests").select("*").eq("staff_id", "o1").single()).data;
  assert.equal(row.reviewed_by, "o1");
  assert.equal(syncs, 1); // booking availability updated for the approved days
});
