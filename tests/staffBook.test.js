// Employees book customers from the crew app: always a request, never a custom price or a
// time outside the open slots; the booking records who made it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SESSION_SECRET ||= "test-secret";
process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";

const staff = [
  { id: "e1", full_name: "Eli Ramos", email: "e@x.com", role: "employee", active: true },
  { id: "gone", full_name: "Former", email: "g@x.com", role: "employee", active: false },
];
const sb = createFakeSupabase({
  staff,
  vehicles: [{ id: "v1", customer_id: "c1" }, { id: "v2", customer_id: "c2" }],
  bookings: [],
  customers: [{ id: "c1", full_name: "Lena Ortiz", email: "lena@x.com", phone: "555" }],
});
const coreCalls = [];
const emails = [];
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_createBookingCore.js", {
  namedExports: {
    createBookingCore: async (opts) => {
      coreCalls.push(opts);
      await sb.from("bookings").insert({ id: "b-new", status: opts.status, customer_id: opts.body.customer_id });
      return { ok: true, booking: { id: "b-new", manage_token: "t" } };
    },
  },
});
mock.module("../api/_customerAddresses.js", { namedExports: { rememberCustomerAddress: async () => {}, loadSavedAddresses: async () => [] } });
mock.module("../api/_crmWorkflow.js", { namedExports: { reconcileCustomerLifecycle: async () => {}, syncCrmProfileStage: async () => {} } });
mock.module("../lib/email/sendBookingCreatedEmail.js", { namedExports: { sendBookingCreatedEmailCore: async (id) => emails.push(id) } });

const { default: staffBook } = await import("../api/_handlers/staff-book.js");
const { default: searchCustomers } = await import("../api/_handlers/admin-search-customers.js");
const { signStaffToken } = await import("../api/_staffAuth.js");

function call(handler, who, { method = "POST", body = {}, query = {} } = {}) {
  const s = staff.find((x) => x.id === who);
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  const headers = s ? { "x-staff-session": signStaffToken(s).token } : {};
  return handler({ method, body, query, headers, url: "/api/x" }, res).then(() => res);
}

const goodBody = {
  customer_id: "c1", vehicle_id: "v1", service_variant_id: "sv1",
  scheduled_start: "2026-11-20T14:00:00.000Z", scheduled_end: "2026-11-20T17:00:00.000Z",
  service_address: "57 Maple Ln, Ghent, NY", discount_code: "SPRING20",
};

test("an employee's booking is a request at the standard price, inside open times only", async () => {
  const res = await call(staffBook, "e1", {
    body: { ...goodBody, status: "confirmed", custom_price_enabled: true, custom_base_price: 1, admin_manual_time: true, total_price: 1 },
  });
  assert.deepEqual([res.statusCode, res.body], [200, { ok: true, bookingId: "b-new", status: "pending" }]);
  const opts = coreCalls.at(-1);
  assert.equal(opts.status, "pending");
  assert.equal(opts.allowAvailabilityOverride, false);
  assert.equal(opts.allowDiscount, true);
  assert.equal(opts.adminPriceOverride, undefined);
  assert.deepEqual(Object.keys(opts.body).sort(), Object.keys(goodBody).sort()); // nothing else gets through
  const booking = (await sb.from("bookings").select("*").eq("id", "b-new").single()).data;
  assert.equal(booking.booked_by, "e1");
  assert.deepEqual(emails, ["b-new"]);
});

test("the vehicle must belong to the customer; signed-out and deactivated staff are refused", async () => {
  const wrong = await call(staffBook, "e1", { body: { ...goodBody, vehicle_id: "v2" } });
  assert.equal(wrong.statusCode, 400);
  assert.equal((await call(staffBook, null, { body: goodBody })).statusCode, 401);
  assert.equal((await call(staffBook, "gone", { body: goodBody })).statusCode, 401);
});

test("employees can search customers to book them", async () => {
  // The in-memory database doesn't implement .or(), so only the login check is asserted here.
  const res = await call(searchCustomers, "e1", { method: "GET", query: { q: "Lena" } });
  assert.ok(![401, 403].includes(res.statusCode));
  assert.equal((await call(searchCustomers, null, { method: "GET", query: { q: "Lena" } })).statusCode, 401);
});
