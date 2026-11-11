// Owner-only endpoints are blocked for managers at the router, and the weekly revenue
// summary managers use adds up.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
process.env.SESSION_SECRET ||= "x";

// Session header "role:<role>" stands in for a signed token.
mock.module("../api/_verifyAdmin.js", {
  defaultExport: async (req) => {
    const h = req.headers["x-admin-session"] || "";
    if (!h.startsWith("role:")) throw new Error("Unauthorized");
    return { ok: true, admin: { id: "x", name: "X", role: h.slice(5) } };
  },
});

const { default: router, isOwnerOnly } = await import("../api/router.js");
const { summarizePayments } = await import("../api/_handlers/admin-payments.js");

function call(route, role) {
  const req = { method: "GET", url: `/api/${route}`, query: { __route: route }, headers: role ? { "x-admin-session": `role:${role}` } : {} };
  let status = 200;
  let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, setHeader() {}, send() { return this; }, end() { return this; } };
  return router(req, res).then(() => ({ status, body }));
}

test("owner-only routes: CRM, Business dashboard, bookkeeping export, expense approvals", () => {
  for (const r of ["admin-crm-customers", "admin-crm-send-email", "admin-analytics", "export-bookkeeping", "admin-expense-review"]) {
    assert.equal(isOwnerOnly(r), true, r);
  }
  for (const r of ["admin-payments", "admin-schedule", "admin-time", "admin-checklists", "admin-staff", "admin-bookings", "admin-list-expenses", "admin-payroll", "cron-crm-automation"]) {
    assert.equal(isOwnerOnly(r), false, r);
  }
});

test("managers get 403 on owner-only routes; signed-out callers get 401", async () => {
  for (const r of ["admin-crm-customers", "admin-analytics", "export-bookkeeping", "admin-expense-review"]) {
    assert.deepEqual(await call(r, "manager"), { status: 403, body: { error: "Owner only" } }, r);
    assert.equal((await call(r, null)).status, 401, r);
  }
});

test("weekly revenue: collected, tips, methods, under-price jobs, still to collect; test bookings ignored", () => {
  const s = summarizePayments([
    { id: "a", status: "completed", total_price: 200, scheduled_start: "2026-11-10T14:00:00Z", job_payments: [{ amount_collected: 200, tip_amount: 20, payment_method: "Cash" }] },
    { id: "b", status: "completed", total_price: "185.50", job_payments: [{ amount_collected: 170, tip_amount: 0, payment_method: "Venmo" }] },
    { id: "c", status: "completed", total_price: 90, job_payments: [] },
    { id: "d", status: "confirmed", total_price: 150, job_payments: [] },
    { id: "t", status: "completed", total_price: 999, customer_notes: "TEST ACCOUNT – owner", job_payments: [{ amount_collected: 999, payment_method: "Cash" }] },
  ]);
  assert.deepEqual(s.totals, { collected: 370, jobs: 3, average_ticket: 123.33, tips: 20, short: 105.5, still_to_collect: 150, jobs_remaining: 1 });
  assert.deepEqual(s.by_method, { Cash: 200, Venmo: 170 });
  assert.deepEqual(s.jobs.map((j) => [j.id, j.short, j.unpaid]), [["a", 0, false], ["b", 15.5, false], ["c", 90, true]]);
});

test("saved addresses: newest first, profile address included, near-duplicates and placeholders dropped", async () => {
  const { savedAddresses, isPlaceholderAddress } = await import("../api/_customerAddresses.js");
  assert.deepEqual(
    savedAddresses({
      bookingAddresses: ["88 Elm St, Cranford, NJ 07016", "1234 Maple Ave, Westfield, NJ 07090, USA", "88 elm st,  Cranford, NJ 07016", "", null],
      profileAddress: "1234 Maple Ave, Westfield, NJ 07090",
    }),
    ["88 Elm St, Cranford, NJ 07016", "1234 Maple Ave, Westfield, NJ 07090, USA"]
  );
  assert.deepEqual(savedAddresses({ bookingAddresses: [], profileAddress: "Address not provided" }), []);
  assert.equal(isPlaceholderAddress(" Address not provided "), true);
  assert.equal(isPlaceholderAddress("5 Oak Rd"), false);
});

test("history search matches name, email and phone digits safely", async () => {
  const { customerSearchFilter, STATUS_GROUPS } = await import("../api/_handlers/admin-history.js");
  assert.equal(customerSearchFilter("Jo"), "full_name.ilike.%Jo%,email.ilike.%Jo%");
  assert.equal(customerSearchFilter("(908) 555"), "full_name.ilike.%908  555%,email.ilike.%908  555%,phone.ilike.%9%0%8%5%5%5%");
  assert.equal(customerSearchFilter("a,b(c)"), "full_name.ilike.%a b c%,email.ilike.%a b c%");
  assert.equal(customerSearchFilter("  "), null);
  assert.deepEqual(STATUS_GROUPS.cancelled, ["cancelled", "denied", "no_show"]);
});
