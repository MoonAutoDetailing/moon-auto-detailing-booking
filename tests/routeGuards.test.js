// Cron jobs only run with CRON_SECRET; customer-email and calendar routes need an admin login;
// starting a maintenance plan needs the activation booking's private link token.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
process.env.SESSION_SECRET ||= "x";
process.env.RESEND_API_KEY ||= "re_test";
process.env.BOOKING_SEASON_CLOSED = "false";

const { isCronRequest } = await import("../api/_cronAuth.js");

test("cron: only the exact Bearer CRON_SECRET works; x-vercel-cron alone is refused", () => {
  const secret = "s3cret-value";
  assert.equal(isCronRequest({ headers: { authorization: "Bearer s3cret-value" } }, secret), true);
  assert.equal(isCronRequest({ headers: { "x-vercel-cron": "1" } }, secret), false);
  assert.equal(isCronRequest({ headers: { authorization: "Bearer wrong" } }, secret), false);
  assert.equal(isCronRequest({ headers: {} }, secret), false);
  // No secret configured → nothing gets in (not even "Bearer undefined").
  assert.equal(isCronRequest({ headers: { authorization: "Bearer undefined" } }, undefined), false);
  assert.equal(isCronRequest({ headers: { authorization: "Bearer " } }, ""), false);
});

const sb = createFakeSupabase({
  bookings: [{ id: "bk1", manage_token: "tok-1", customer_id: "c1", vehicle_id: "v1", service_variant_id: "sv1", status: "pending" }],
  subscriptions: [],
  service_variants: [{ id: "sv1", services: { category: "Combined Package" } }],
});
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../lib/email/sendSubscriptionCreatedEmail.js", { namedExports: { sendSubscriptionCreatedEmailCore: async () => ({ success: true }) } });
mock.module("../api/_verifyAdmin.js", {
  defaultExport: async (req) => {
    const h = req.headers["x-admin-session"] || "";
    if (!h.startsWith("role:")) throw new Error("Unauthorized");
    return { ok: true, admin: { id: "x", name: "X", role: h.slice(5) } };
  },
});

const { default: router, ADMIN_REQUIRED } = await import("../api/router.js");

function callRoute(route, headers = {}) {
  const req = { method: "POST", url: `/api/${route}`, query: { __route: route }, headers, body: {} };
  let status = 200;
  const res = { status(s) { status = s; return this; }, json() { return this; }, setHeader() {}, send() { return this; }, end() { return this; } };
  return router(req, res).then(() => status);
}

test("customer-email, test-email and calendar routes refuse signed-out callers", async () => {
  assert.ok(ADMIN_REQUIRED.includes("send-booking-cancelled-email"));
  assert.ok(ADMIN_REQUIRED.includes("create-calendar-event"));
  for (const r of ADMIN_REQUIRED) assert.equal(await callRoute(r), 401, r);
});

const { default: createSubscription } = await import("../api/_handlers/create-subscription.js");
function sub(body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  res.end = () => res;
  return createSubscription({ method: "POST", body }, res).then(() => res);
}
const base = { customer_id: "c1", vehicle_id: "v1", service_variant_id: "sv1", default_address: "14 Church St", frequency: "monthly", activation_booking_id: "bk1" };

test("starting a plan needs the activation booking's link token and matching details", async () => {
  assert.equal((await sub(base)).statusCode, 403);
  assert.equal((await sub({ ...base, manage_token: "guess" })).statusCode, 403);
  assert.equal((await sub({ ...base, manage_token: "tok-1", customer_id: "someone-else" })).statusCode, 403);
  const ok = await sub({ ...base, manage_token: "tok-1" });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal((await sb.from("subscriptions").select("*")).data.length, 1);
});
