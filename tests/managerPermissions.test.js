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

test("Needs attention: most urgent first, expense approvals only for the owner", async () => {
  const { attentionItems } = await import("../api/_handlers/admin-attention.js");
  const counts = { forgotClockOut: ["Eli"], onClock: ["Sam"], overdueJobs: 2, timeOff: 1, expenses: 3, payrollReady: true, payrollHours: 74.75, drafts: 4 };
  const owner = attentionItems(counts, { isOwner: true });
  assert.deepEqual(owner.map((i) => i.key), ["clock", "overdue", "timeoff", "expenses", "payroll", "drafts", "onclock"]);
  assert.equal(owner[0].title, "1 person still clocked in after 12+ hours");
  assert.equal(owner[1].title, "2 jobs finished but not marked complete");
  assert.equal(owner.find((i) => i.key === "payroll").detail, "74.8 hours clocked");
  const manager = attentionItems(counts, { isOwner: false });
  assert.equal(manager.some((i) => i.key === "expenses"), false);
  assert.deepEqual(attentionItems({ forgotClockOut: [], onClock: [], overdueJobs: 0, timeOff: 0, expenses: 0, payrollReady: false, payrollHours: 0, drafts: 0 }, { isOwner: true }), []);
});

test("every icon the pages ask for exists in the icon set", async () => {
  const { ICON_NAMES } = await import("../ui-icons.js");
  const { readFileSync } = await import("node:fs");
  const used = new Set();
  for (const f of ["admin.html", "staff.html", "api/_handlers/admin-attention.js"]) {
    const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    for (const m of src.matchAll(/icon\(\s*"([a-zA-Z]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/icon: "([a-zA-Z]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-icon="([a-zA-Z]+)"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !ICON_NAMES.includes(n));
  assert.deepEqual(missing, []);
});
