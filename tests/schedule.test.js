// Scheduling rules (availability precedence, shift warnings, coverage) and the morning
// crew email job (once per shift, retried after a failure).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

mock.module("../api/_sendEmail.js", { namedExports: { sendBookingEmail: async () => ({ success: true }) } });

const sched = await import("../api/_schedule.js");
const { runCrewMorningEmails } = await import("../api/_crewMorning.js");
const { renderWeekEmail, renderMorningEmail, niceTime } = await import("../lib/email/crewEmails.js");

// 2026-11-16 is a Monday.
const weekly = [
  { weekday: 1, available: true, start_time: "08:00:00", end_time: "16:00:00" },
  { weekday: 2, available: true, start_time: null, end_time: null },
  { weekday: 3, available: false, note: "School" },
];

test("dates and times are validated and normalised", () => {
  assert.equal(sched.normTime("8:00"), undefined);
  assert.equal(sched.normTime("08:00:00"), "08:00");
  assert.equal(sched.normTime(""), null);
  assert.equal(sched.isDate("2026-02-29"), false);
  assert.equal(sched.isDate("2028-02-29"), true);
  assert.equal(sched.weekdayOf("2026-11-16"), 1);
  assert.equal(sched.addDays("2026-11-30", 1), "2026-12-01");
  assert.deepEqual(sched.datesFrom("2026-11-16", 3), ["2026-11-16", "2026-11-17", "2026-11-18"]);
});

test("availability: weekly rule, one-day exception, approved time off, and nothing set", () => {
  assert.deepEqual(
    pick(sched.availabilityOn("2026-11-16", { weekly })),
    { status: "partial", start: "08:00", end: "16:00", source: "weekly" }
  );
  assert.equal(sched.availabilityOn("2026-11-17", { weekly }).status, "available");
  assert.equal(sched.availabilityOn("2026-11-18", { weekly }).status, "unavailable");
  assert.equal(sched.availabilityOn("2026-11-19", { weekly }).status, "unknown");

  // A one-day exception beats the weekly rule.
  const exceptions = [{ on_date: "2026-11-18", available: true, start_time: null, end_time: null }];
  assert.equal(sched.availabilityOn("2026-11-18", { weekly, exceptions }).status, "available");

  // Approved time off beats everything; pending is only noted.
  const timeOff = [
    { start_date: "2026-11-16", end_date: "2026-11-17", status: "approved", reason: "Vacation" },
    { start_date: "2026-11-20", end_date: "2026-11-20", status: "pending" },
    { start_date: "2026-11-21", end_date: "2026-11-21", status: "denied" },
  ];
  const off = sched.availabilityOn("2026-11-17", { weekly, timeOff });
  assert.equal(off.status, "unavailable");
  assert.equal(off.source, "time_off");
  assert.equal(sched.availabilityOn("2026-11-20", { weekly, timeOff }).pendingTimeOff, true);
  assert.equal(sched.availabilityOn("2026-11-21", { weekly, timeOff }).pendingTimeOff, false);
});

function pick(a) {
  return { status: a.status, start: a.start, end: a.end, source: a.source };
}

test("shift warnings explain conflicts with availability", () => {
  const partial = sched.availabilityOn("2026-11-16", { weekly });
  assert.deepEqual(sched.shiftWarnings({ start_time: "09:00", end_time: "15:00" }, partial), []);
  assert.deepEqual(sched.shiftWarnings({ start_time: "07:00", end_time: "17:00" }, partial), [
    "Available from 08:00",
    "Available until 16:00",
  ]);
  assert.deepEqual(sched.shiftWarnings({ start_time: "08:00", end_time: "16:00" }, sched.availabilityOn("2026-11-18", { weekly })), [
    "Marked unavailable this day",
  ]);
  assert.deepEqual(sched.shiftWarnings({ start_time: "06:00", end_time: "19:00" }, sched.availabilityOn("2026-11-19", { weekly })), [
    "No availability set for this day",
    "Shift is over 12 hours",
  ]);
});

test("shift validation", () => {
  assert.deepEqual(sched.parseShift({ shift_date: "2026-11-16", start_time: "08:00", end_time: "16:30" }).shift, {
    shift_date: "2026-11-16", start_time: "08:00", end_time: "16:30",
  });
  assert.match(sched.parseShift({ shift_date: "2026-11-16", start_time: "16:00", end_time: "08:00" }).error, /after start/);
  assert.match(sched.parseShift({ shift_date: "nope", start_time: "08:00", end_time: "09:00" }).error, /Invalid date/);
  assert.match(sched.parseShift({ shift_date: "2026-11-16" }).error, /required/);
  // Partial edit checked against the existing shift.
  const existing = { shift_date: "2026-11-16", start_time: "08:00:00", end_time: "16:00:00" };
  assert.match(sched.parseShift({ end_time: "07:00" }, existing).error, /after start/);
  assert.deepEqual(sched.parseShift({ end_time: "17:00" }, existing).shift, { end_time: "17:00" });
});

test("day coverage warnings", () => {
  const jobs = [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:30" }];
  assert.deepEqual(sched.dayWarnings({ jobs, shifts: [] }), ["2 jobs but nobody scheduled"]);
  assert.deepEqual(
    sched.dayWarnings({ jobs, shifts: [{ start_time: "09:30", end_time: "16:00" }] }),
    ["Only one person scheduled", "First job starts before anyone's shift", "Last job ends after everyone's shift"]
  );
  assert.deepEqual(
    sched.dayWarnings({ jobs, shifts: [{ start_time: "08:30", end_time: "17:00" }, { start_time: "08:30", end_time: "17:00" }] }),
    []
  );
  assert.deepEqual(sched.dayWarnings({ jobs: [], shifts: [] }), []);
});

test("crew emails render shift times and the ceramic warning", () => {
  assert.equal(niceTime("08:00:00"), "8am");
  assert.equal(niceTime("16:30"), "4:30pm");
  assert.equal(niceTime("12:00"), "12pm");
  const week = renderWeekEmail({ full_name: "Eli Smith" }, [
    { shift_date: "2026-11-16", start_time: "08:00", end_time: "16:00" },
    { shift_date: "2026-11-18", start_time: "09:00", end_time: "17:30", notes: "Ceramic day" },
  ]);
  assert.equal(week.subject, "Your schedule: 2 shifts");
  assert.match(week.html, /Hi Eli/);
  assert.match(week.html, /Monday, Nov 16/);
  assert.match(week.html, /5:30pm/);

  const morning = renderMorningEmail({ full_name: "Eli" }, { start_time: "08:00", end_time: "16:00" }, [
    { time: "9:00 AM", service: "Exterior Detail (Level 2)", address: "1 Main St", job_flag: "ceramic" },
  ]);
  assert.match(morning.subject, /1 job · shift 8am–4pm · ceramic/);
  assert.match(morning.html, /Ceramic coating today/);
});

test("morning crew emails go out once per published shift and retry after a failure", async () => {
  const today = "2026-11-16";
  const sb = createFakeSupabase({
    shifts: [
      { id: "s1", staff_id: "a", shift_date: today, start_time: "08:00", end_time: "16:00", published: true, morning_email_sent_at: null },
      { id: "s2", staff_id: "b", shift_date: today, start_time: "08:00", end_time: "16:00", published: true, morning_email_sent_at: null },
      { id: "s3", staff_id: "a", shift_date: today, start_time: "17:00", end_time: "18:00", published: false, morning_email_sent_at: null },
      { id: "s4", staff_id: "a", shift_date: "2026-11-17", start_time: "08:00", end_time: "16:00", published: true, morning_email_sent_at: null },
    ],
    staff: [
      { id: "a", full_name: "Ann", email: "ann@x.com", active: true },
      { id: "b", full_name: "Bob", email: "bob@x.com", active: true },
    ],
    bookings: [
      { status: "confirmed", scheduled_start: "2026-11-16T14:00:00.000Z", service_address: "1 Main", job_flag: null, service_variants: null },
      { status: "cancelled", scheduled_start: "2026-11-16T15:00:00.000Z", service_address: "2 Main", job_flag: null, service_variants: null },
    ],
  });

  const sent = [];
  const flaky = async (person, shift, jobs) => {
    sent.push({ who: person.id, shift: shift.id, jobs: jobs.length });
    return person.id === "b" && sent.filter((s) => s.who === "b").length === 1 ? { success: false, error: "down" } : { success: true };
  };

  assert.deepEqual(await runCrewMorningEmails({ sb, today, send: flaky }), { sent: 1, failed: 1 });
  assert.deepEqual(sent, [{ who: "a", shift: "s1", jobs: 1 }, { who: "b", shift: "s2", jobs: 1 }]);

  // Second run: Ann's already stamped, Bob's failed send is retried.
  assert.deepEqual(await runCrewMorningEmails({ sb, today, send: flaky }), { sent: 1, failed: 0 });
  assert.deepEqual(sent.slice(2), [{ who: "b", shift: "s2", jobs: 1 }]);

  // Third run: nothing left.
  assert.deepEqual(await runCrewMorningEmails({ sb, today, send: flaky }), { sent: 0, failed: 0 });
});

test("auto-fill drafts shifts around each day's jobs, respecting availability", () => {
  assert.deepEqual(sched.coverTimes([{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:30" }]), { start: "08:30", end: "17:00" });
  assert.equal(sched.coverTimes([]), null);

  const days = [
    { date: "2026-11-16", jobs: [{ start: "09:00", end: "15:00" }] }, // Monday: Ann 08:00–16:00, Bob all day
    { date: "2026-11-18", jobs: [{ start: "10:00", end: "12:00" }] }, // Wednesday: Ann off
    { date: "2026-11-19", jobs: [] },                                  // no jobs → no shifts
  ];
  const people = [{ id: "ann" }, { id: "bob" }];
  const avail = {
    ann: { weekly, exceptions: [], timeOff: [] },
    bob: { weekly: [], exceptions: [], timeOff: [{ start_date: "2026-11-18", end_date: "2026-11-18", status: "approved" }] },
  };
  const availabilityFor = (id, date) => sched.availabilityOn(date, avail[id]);

  const plan = sched.planAutoFill({ days, people, availabilityFor, existing: [{ staff_id: "bob", shift_date: "2026-11-16" }] });
  assert.deepEqual(plan.shifts, [
    // Monday: the 08:30–15:30 cover already fits inside Ann's 08:00–16:00 hours.
    { staff_id: "ann", shift_date: "2026-11-16", start_time: "08:30", end_time: "15:30" },
  ]);
  assert.deepEqual(plan.skipped, [
    { staff_id: "ann", date: "2026-11-18", reason: "off" },
    { staff_id: "bob", date: "2026-11-18", reason: "time off" },
  ]);
});

test("auto-fill trims to partial availability and skips when hours don't overlap", () => {
  const partial = (start, end) => () => ({ status: "partial", start, end, source: "weekly" });
  const day = [{ date: "2026-11-16", jobs: [{ start: "07:00", end: "17:00" }] }];
  assert.deepEqual(
    sched.planAutoFill({ days: day, people: [{ id: "a" }], availabilityFor: partial("09:00", "13:00") }).shifts,
    [{ staff_id: "a", shift_date: "2026-11-16", start_time: "09:00", end_time: "13:00" }]
  );
  const late = [{ date: "2026-11-16", jobs: [{ start: "08:00", end: "10:00" }] }];
  const r = sched.planAutoFill({ days: late, people: [{ id: "a" }], availabilityFor: partial("12:00", "18:00") });
  assert.deepEqual(r.shifts, []);
  assert.equal(r.skipped[0].reason, "available hours don't overlap the jobs");
});
