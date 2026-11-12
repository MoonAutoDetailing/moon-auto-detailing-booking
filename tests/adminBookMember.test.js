// Booking a maintenance member's window from the admin plan card.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";

const sb = createFakeSupabase({ service_variants: [{ id: "sv1", duration_minutes: 180 }] });
const cycle = { id: "cy1", status: "open", window_start_date: "2026-11-16", window_end_date: "2026-11-20", cycle_index: 5 };
let resolved = { subscription: { id: "sub1", status: "active", customer_id: "c1", vehicle_id: "v1", service_variant_id: "sv1", default_address: "14 Church St" }, activeCycle: cycle };
let phase = "bookable";
let confirmOk = true;
const created = [];

mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_verifyAdmin.js", { defaultExport: async () => ({ ok: true, admin: { id: "m1", role: "manager" } }) });
mock.module("../api/_subscriptions/resolveSubscriptionById.js", { namedExports: { resolveSubscriptionById: async () => resolved } });
mock.module("../api/_subscriptions/memberContext.js", { namedExports: { buildNextService: async () => ({ phase, price: { base_price: 175, price_mode: "discounted" } }) } });
mock.module("../api/_createBookingCore.js", {
  namedExports: { createBookingCore: async (args) => { created.push(args); return { ok: true, bookingId: "bk" + created.length }; } },
});
mock.module("../api/_confirmBookingCore.js", {
  namedExports: { confirmBookingCore: async () => (confirmOk ? { ok: true } : { ok: false, statusCode: 500, body: { message: "Calendar error" } }) },
});
mock.module("../lib/email/sendBookingCreatedEmail.js", { namedExports: { sendBookingCreatedEmailCore: async () => ({}) } });

const { default: handler } = await import("../api/_handlers/admin-book-member.js");

function call(body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler({ method: "POST", body, headers: {} }, res).then(() => res);
}

test("books the window from the plan: plan's customer, vehicle, service, member price; end from duration", async () => {
  const res = await call({ subscription_id: "sub1", scheduled_start: "2026-11-17T15:00:00.000Z" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "confirmed");
  const args = created.at(-1);
  assert.deepEqual(
    [args.body.customer_id, args.body.vehicle_id, args.body.service_variant_id, args.body.service_address, args.body.scheduled_end],
    ["c1", "v1", "sv1", "14 Church St", "2026-11-17T18:00:00.000Z"]
  );
  assert.equal(args.memberCycle.cycle.id, "cy1");
  assert.equal(args.memberCycle.price.price_mode, "discounted");
  assert.equal(args.allowAvailabilityOverride, false);
});

test("a time outside the window is refused with how to fix it", async () => {
  const res = await call({ subscription_id: "sub1", scheduled_start: "2026-11-25T15:00:00.000Z" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /\+5 days free/);
});

test("manual time skips the availability check; an already-booked window is refused", async () => {
  await call({ subscription_id: "sub1", scheduled_start: "2026-11-18T13:00:00.000Z", manual_time: true });
  assert.equal(created.at(-1).allowAvailabilityOverride, true);
  phase = "booked";
  const res = await call({ subscription_id: "sub1", scheduled_start: "2026-11-18T13:00:00.000Z" });
  assert.equal(res.statusCode, 409);
  phase = "bookable";
});

test("if confirming fails the booking stays as a request (never deleted) with a warning", async () => {
  confirmOk = false;
  const res = await call({ subscription_id: "sub1", scheduled_start: "2026-11-19T15:00:00.000Z" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "pending");
  assert.match(res.body.warning, /Calendar error/);
  confirmOk = true;
});

test("no open window → tells the manager to start one", async () => {
  resolved = { ...resolved, activeCycle: null };
  const res = await call({ subscription_id: "sub1", scheduled_start: "2026-11-17T15:00:00.000Z" });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Move next window/);
});
