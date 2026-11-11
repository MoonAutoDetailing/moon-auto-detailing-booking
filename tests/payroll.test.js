// Payroll math: wages with overtime, tip splits in exact cents, pay-backs, warnings,
// CSV, and the business summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCents, computePayroll, payrollCsv, summarizeBusiness } from "../api/_payroll.js";
import { payWeek } from "../api/_timeclock.js";

const week = payWeek("2026-11-11"); // Mon Nov 9 – Sun Nov 15
const settings = { weeklyOvertimeHours: 40, overtimeMultiplier: 1.5, radiusM: 400 };
const now = new Date("2026-11-20T00:00:00Z");
const staff = [
  { id: "ann", full_name: "Ann Lee", hourly_rate: 20 },
  { id: "bob", full_name: "Bob Ray", hourly_rate: "18.50" },
  { id: "cy", full_name: "Cy Park", hourly_rate: null },
];
// Each day 13:00–22:00 UTC = 9 hours.
const shift = (who, day, hours = 9, extra = {}) => {
  const start = new Date(Date.UTC(2026, 10, 9 + day, 13));
  return { id: `${who}${day}`, staff_id: who, clock_in_at: start.toISOString(), clock_out_at: new Date(start.getTime() + hours * 3600000).toISOString(), verify_method: "gps", ...extra };
};

test("splitCents always adds up and spreads leftover cents", () => {
  assert.deepEqual(splitCents(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitCents(1, 2), [1, 0]);
  assert.deepEqual(splitCents(0, 2), [0, 0]);
  assert.deepEqual(splitCents(500, 0), []);
});

test("wages with overtime over 40 hours", () => {
  const r = computePayroll({
    week, staff, settings, now,
    entries: [0, 1, 2, 3, 4].map((d) => shift("ann", d)).concat([shift("bob", 0, 8), shift("bob", 1, 7.5)]),
  });
  const ann = r.lines.find((l) => l.staff_id === "ann");
  assert.equal(ann.regular_hours, 40);
  assert.equal(ann.overtime_hours, 5);
  assert.equal(ann.regular_pay, 800);
  assert.equal(ann.overtime_pay, 150); // 5 × 20 × 1.5
  assert.equal(ann.total, 950);
  const bob = r.lines.find((l) => l.staff_id === "bob");
  assert.equal(bob.regular_hours, 15.5);
  assert.equal(bob.regular_pay, 286.75);
  assert.deepEqual(r.totals, { hours: 60.5, wages: 1236.75, tips: 0, reimbursements: 0, total: 1236.75 });
});

test("tips split evenly between the crew on each job; unassigned tips are reported", () => {
  const r = computePayroll({
    week, staff, settings, now,
    tipJobs: [
      { booking_id: "b1", tip: 25, staff_ids: ["ann", "bob"] },
      { booking_id: "b2", tip: "10.01", staff_ids: ["bob", "ann"] }, // odd cent → first alphabetically (ann)
      { booking_id: "b3", tip: 15, staff_ids: [] },                  // completed from admin, no crew recorded
      { booking_id: "b4", tip: 0, staff_ids: ["ann"] },
    ],
  });
  const ann = r.lines.find((l) => l.staff_id === "ann");
  const bob = r.lines.find((l) => l.staff_id === "bob");
  assert.equal(ann.tips, 17.51);
  assert.equal(bob.tips, 17.5);
  assert.equal(Math.round((ann.tips + bob.tips) * 100), 3501);
  assert.deepEqual(ann.details.tip_jobs, [{ booking_id: "b1", share: 12.5 }, { booking_id: "b2", share: 5.01 }]);
  assert.deepEqual(r.unassigned_tips, [{ booking_id: "b3", tip: 15 }]);
});

test("pay-backs are added and listed; warnings for missing rate and open entries", () => {
  const r = computePayroll({
    week, staff, settings, now: new Date("2026-11-11T20:00:00Z"),
    entries: [shift("cy", 0, 6), { id: "open", staff_id: "bob", clock_in_at: "2026-11-11T13:00:00Z", clock_out_at: null, verify_method: "gps" }],
    reimbursements: [{ id: "x1", staff_id: "cy", amount: "42.57" }, { id: "x2", staff_id: "cy", amount: 10 }],
  });
  const cy = r.lines.find((l) => l.staff_id === "cy");
  assert.equal(cy.regular_pay, 0);
  assert.equal(cy.reimbursements, 52.57);
  assert.equal(cy.total, 52.57);
  assert.deepEqual(cy.details.expense_ids, ["x1", "x2"]);
  assert.match(cy.warnings[0], /No hourly rate/);
  const bob = r.lines.find((l) => l.staff_id === "bob");
  assert.ok(bob.warnings.some((w) => /Still clocked in/.test(w)));
});

test("voided entries and people with nothing to pay are left out", () => {
  const r = computePayroll({ week, staff, settings, now, entries: [shift("ann", 0, 8, { voided_at: "2026-11-10T00:00:00Z" })] });
  assert.deepEqual(r.lines, []);
  assert.equal(r.totals.total, 0);
});

test("payroll CSV", () => {
  const r = computePayroll({ week, staff, settings, now, entries: [shift("bob", 0, 8)] });
  const csv = payrollCsv({ week_start: "2026-11-09", week_end: "2026-11-15", status: "approved" }, r.lines);
  const [head, row] = csv.split("\n");
  assert.match(head, /"Name","Rate","Regular hours"/);
  assert.equal(row, '"2026-11-09","2026-11-15","Bob Ray","18.5","8","0","148.00","0.00","0.00","0.00","148.00","approved"');
});

test("business summary counts real costs only", () => {
  const s = summarizeBusiness({
    jobs: [{ amount_collected: 200, tip_amount: 20 }, { amount_collected: "150.50", tip_amount: 0 }],
    expenses: [
      { expense_type: "Direct Cost", amount: 40 },
      { expense_type: "Operating Expense", amount: 10.5 },
      { expense_type: "Asset Purchase", amount: 300 },
      { expense_type: "Owner Draw", amount: 1000 },
    ],
    laborCost: 120,
    hours: 9,
  });
  assert.deepEqual(s, {
    revenue: 350.5, tips: 20, jobs: 2, average_ticket: 175.25, expenses: 50.5, asset_purchases: 300,
    labor: 120, profit: 180, margin: 51.4, hours: 9, hours_per_job: 4.5,
  });
  assert.equal(summarizeBusiness({}).margin, 0);
});

test("analytics periods: months and Monday weeks in New York time, oldest first", async () => {
  process.env.SUPABASE_URL ||= "http://fake";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
  process.env.SESSION_SECRET ||= "x";
  const { periods } = await import("../api/_handlers/admin-analytics.js");
  const m = periods("month", "2026-11-11", 3);
  assert.deepEqual(m.map((p) => [p.key, p.startDate, p.endDate]), [
    ["2026-09", "2026-09-01", "2026-09-30"],
    ["2026-10", "2026-10-01", "2026-10-31"],
    ["2026-11", "2026-11-01", "2026-11-30"],
  ]);
  assert.equal(m[2].startISO, "2026-11-01T04:00:00.000Z"); // EDT until Nov 1, 2am
  assert.equal(m[2].endISO, "2026-12-01T05:00:00.000Z");
  const w = periods("week", "2026-11-11", 2);
  assert.deepEqual(w.map((p) => [p.startDate, p.endDate]), [["2026-11-02", "2026-11-08"], ["2026-11-09", "2026-11-15"]]);
});
