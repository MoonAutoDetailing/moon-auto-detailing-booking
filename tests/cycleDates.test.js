import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped,
  cadenceDate,
  computeCycleWindow,
  getCycleEndDate,
  getPushbackEnd,
  getReminderDates,
  nextBusinessDayOnOrAfter,
  todayNY,
  toNYDate,
  addBusinessDays
} from "../api/_subscriptions/lifecycle.js";

test("month addition clamps to month end and never drifts", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29"); // leap year
  assert.equal(addMonthsClamped("2026-08-31", 1), "2026-09-30");
  assert.equal(addMonthsClamped("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonthsClamped("2026-12-15", 1), "2027-01-15");
  // computed from the anchor each time: Jan 31 → Feb 28 → Mar 31 (not Mar 28)
  assert.equal(cadenceDate("2026-01-31", "monthly", 2), "2026-03-31");
  assert.equal(cadenceDate("2026-05-31", "quarterly", 1), "2026-08-31");
  assert.equal(cadenceDate("2026-11-29", "quarterly", 1), "2027-02-28");
});

test("biweekly cadence is 14-day steps from the anchor", () => {
  assert.equal(cadenceDate("2026-11-10", "biweekly", 1), "2026-11-24");
  assert.equal(cadenceDate("2026-11-10", "biweekly", 3), "2026-12-22");
  assert.equal(cadenceDate("2026-12-29", "biweekly", 1), "2027-01-12");
});

test("weekend cadence dates roll forward to Monday", () => {
  assert.equal(nextBusinessDayOnOrAfter("2026-11-14"), "2026-11-16"); // Sat
  assert.equal(nextBusinessDayOnOrAfter("2026-11-15"), "2026-11-16"); // Sun
  assert.equal(nextBusinessDayOnOrAfter("2026-11-16"), "2026-11-16"); // Mon
});

test("windows cover exactly 5 (or 10) business days including the start", () => {
  assert.equal(getCycleEndDate("2026-11-16", "monthly"), "2026-11-20"); // Mon–Fri
  assert.equal(getCycleEndDate("2026-11-18", "biweekly"), "2026-11-24"); // Wed → next Tue
  assert.equal(getCycleEndDate("2026-11-16", "quarterly"), "2026-11-27"); // 10 business days
});

test("computeCycleWindow: anchor-based, weekend roll, opens 7 days before", () => {
  // anchor Tue Jun 10 2026, monthly: cycle 5 → Nov 10 (Tue) – Nov 16 (Mon)
  assert.deepEqual(computeCycleWindow("2026-06-10", "monthly", 5), {
    start: "2026-11-10",
    end: "2026-11-16",
    opensOn: "2026-11-03"
  });
  // anchor Thu Aug 13, quarterly cycle 1 → Fri Nov 13 – Thu Nov 26
  assert.deepEqual(computeCycleWindow("2026-08-13", "quarterly", 1), {
    start: "2026-11-13",
    end: "2026-11-26",
    opensOn: "2026-11-06"
  });
  // anchor Sat-landing: Jan 31 2026 monthly cycle 1 → Feb 28 2026 is Sat → Mon Mar 2
  assert.equal(computeCycleWindow("2026-01-31", "monthly", 1).start, "2026-03-02");
  // re-anchored after resume: base index 4, anchor Dec 1 → index 5 = Jan 1 2027 (Fri)
  assert.equal(computeCycleWindow("2026-12-01", "monthly", 5, 4).start, "2027-01-01");
});

test("reminder and pushback dates", () => {
  assert.deepEqual(getReminderDates("2026-11-20"), { reminder1: "2026-11-17", reminder2: "2026-11-19" });
  assert.equal(getPushbackEnd("2026-11-20"), "2026-11-27"); // Fri + 5 business days = next Fri
  assert.equal(addBusinessDays("2026-12-24", 5), "2026-12-31");
});

test("New York dates from timestamps, across DST and late-evening UTC", () => {
  // 02:00 UTC on Nov 11 is still Nov 10 in New York (cron run time)
  assert.equal(todayNY(new Date("2026-11-11T02:00:00Z")), "2026-11-10");
  assert.equal(todayNY(new Date("2026-07-01T03:30:00Z")), "2026-06-30"); // EDT
  assert.equal(toNYDate("2026-11-17T23:30:00Z"), "2026-11-17"); // 6:30pm EST
  assert.equal(toNYDate("2026-11-18T04:30:00Z"), "2026-11-17"); // 11:30pm EST
  assert.equal(toNYDate("2026-03-08T07:30:00Z"), "2026-03-08"); // DST change morning
  assert.equal(toNYDate("2026-11-01T05:30:00Z"), "2026-11-01"); // DST end morning
});
