// Booking availability follows team availability; hierarchy rules for time, pay and expenses.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
process.env.SESSION_SECRET ||= "x";

const cov = await import("../api/_teamCoverage.js");
const { canManageWorkOf } = await import("../api/_staffAuth.js");
const { reviewDenied, rejectBlocked } = await import("../api/_expenses.js");

// Week of Mon 2026-11-16.
const MON = "2026-11-16", TUE = "2026-11-17", WED = "2026-11-18", SAT = "2026-11-21";
const staff = [
  { id: "own", full_name: "Darren", role: "owner", active: true },
  { id: "m1", full_name: "Maria", role: "manager", active: true },
  { id: "e1", full_name: "Eli", role: "employee", active: true },
  { id: "gone", full_name: "Former", role: "employee", active: false },
];

test("the owner only counts once they've set a usual week; inactive people never count", () => {
  assert.deepEqual(cov.crewForCoverage(staff, []).map((p) => p.id), ["m1", "e1"]);
  assert.deepEqual(cov.crewForCoverage(staff, [{ staff_id: "own", weekday: 1, available: true }]).map((p) => p.id), ["own", "m1", "e1"]);
});

test("coverage: time off and 'can't work' days take people out; unset days count as available", () => {
  const crew = cov.crewForCoverage(staff, []);
  const c = cov.coverageByDate([MON, TUE, WED], {
    crew,
    avail: [{ staff_id: "m1", on_date: WED, available: false }],
    timeOff: [{ staff_id: "e1", start_date: TUE, end_date: WED, status: "approved" }],
  });
  assert.deepEqual(c[MON].available, ["Maria", "Eli"]);
  assert.deepEqual(c[TUE].available, ["Maria"]);
  assert.deepEqual(c[WED].available, []);
});

test("plan: one person → solo, nobody → closed, two → normal; manual settings win; weekends skipped", () => {
  const coverage = {
    [MON]: { available: ["A", "B"] }, [TUE]: { available: ["A"] }, [WED]: { available: [] }, [SAT]: { available: [] },
    "2026-11-19": { available: ["A"] }, "2026-11-20": { available: [] },
  };
  const dates = Object.keys(coverage);
  const plan = cov.planSync(dates, coverage, {
    staffing: { [MON]: { source: "auto" }, "2026-11-19": { source: "manual" } },
    blocks: { [MON]: { source: "auto" }, "2026-11-20": { source: "manual", mode: "open" } },
  });
  assert.deepEqual(plan, { addSolo: [TUE], removeSolo: [MON], addBlock: [WED], removeBlock: [MON] });
});

test("sync writes auto rows and removes them when people are available again", async () => {
  const sb = createFakeSupabase({
    staff,
    staff_availability: [],
    time_off_requests: [{ staff_id: "e1", start_date: TUE, end_date: TUE, status: "approved" }],
    staffing_overrides: [],
    availability_overrides: [{ override_date: WED, mode: "open", scope: "full_day", source: "manual" }],
  });
  const plan = await cov.syncBookingAvailability(sb, { from: MON, days: 5 });
  assert.deepEqual(plan.addSolo, [TUE]);
  const solo = (await sb.from("staffing_overrides").select("*")).data;
  assert.deepEqual(solo.map((r) => [r.override_date, r.source]), [[TUE, "auto"]]);

  await sb.from("time_off_requests").update({ status: "cancelled" }).eq("staff_id", "e1");
  const again = await cov.syncBookingAvailability(sb, { from: MON, days: 5 });
  assert.deepEqual(again.removeSolo, [TUE]);
  assert.equal((await sb.from("staffing_overrides").select("*")).data.length, 0);
  // The manual "open" on Wednesday is untouched.
  assert.equal((await sb.from("availability_overrides").select("*")).data.length, 1);
});

test("sync does nothing when nobody is set up on the team", async () => {
  const sb = createFakeSupabase({ staff: [staff[0]], staff_availability: [], time_off_requests: [], staffing_overrides: [], availability_overrides: [] });
  const plan = await cov.syncBookingAvailability(sb, { from: MON, days: 5 });
  assert.equal(plan.skipped, "no team members");
});

test("time-off warnings name solo and closed days and booked jobs", () => {
  const text = cov.impactWarning([
    { date: TUE, others: 1, others_names: ["Maria"], jobs: 2 },
    { date: WED, others: 0, others_names: [], jobs: 0 },
  ], { names: true });
  assert.equal(text, "Tue, Nov 17: only Maria would be working (solo mode) · 2 jobs booked\nWed, Nov 18: nobody else is available — booking closes that day");
  assert.equal(cov.impactWarning([]), "");
});

test("hierarchy: managers handle employees only; the owner handles everyone", () => {
  const owner = { id: "own", role: "owner" }, mgr = { id: "m1", role: "manager" };
  assert.equal(canManageWorkOf(owner, { id: "m1", role: "manager" }), true);
  assert.equal(canManageWorkOf(mgr, { id: "e1", role: "employee" }), true);
  assert.equal(canManageWorkOf(mgr, { id: "m1", role: "manager" }), false);
  assert.equal(canManageWorkOf(mgr, { id: "m2", role: "manager" }), false);
  assert.equal(canManageWorkOf({ id: "e1", role: "employee" }, { id: "e2", role: "employee" }), false);
});

test("expenses: managers review employees' receipts only; paid-back ones can't be rejected", () => {
  const mgr = { id: "m1", role: "manager" };
  assert.equal(reviewDenied(mgr, { id: "e1", role: "employee" }), null);
  assert.match(reviewDenied(mgr, { id: "m1", role: "manager" }), /owner/);
  assert.match(reviewDenied(mgr, undefined), /owner/);
  assert.equal(reviewDenied({ id: "own", role: "owner" }, { id: "m1", role: "manager" }), null);
  assert.equal(rejectBlocked({}), null);
  assert.match(rejectBlocked({ payroll_run_id: "r" }), /reopen/);
  assert.match(rejectBlocked({ reimbursed_at: "2026-11-10" }), /paid back/);
});
