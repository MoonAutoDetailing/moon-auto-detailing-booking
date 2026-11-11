// Crew job rules (checklist selection, completion gate, NY day ranges, photo paths) and the
// shared completion core used by both the admin page and the crew app.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

const cycleCalls = [];
mock.module("../api/_subscriptions/cycleState.js", {
  namedExports: { onBookingCompleted: async (_sb, id, opts) => { cycleCalls.push({ id, ...opts }); } },
});
mock.module("../api/_crmWorkflow.js", {
  namedExports: {
    createFollowUpTaskIfMissing: async () => {},
    reconcileCustomerLifecycle: async () => {},
    syncCrmProfileStage: async () => {},
  },
});
mock.module("../lib/email/sendBookingCompletedEmail.js", {
  namedExports: { sendBookingCompletedEmailCore: async () => ({ success: true }) },
});

const jobs = await import("../api/_jobs.js");
const { completeBooking, parsePayment } = await import("../api/_completeBookingCore.js");

const STEPS = [
  { id: "g1", scope: "general", min_level: 1, step_order: 10, text: "Confirm", required: true },
  { id: "g9", scope: "general", min_level: 1, step_order: 90, text: "Final walkaround", required: true },
  { id: "i1", scope: "interior", min_level: 1, step_order: 10, text: "Vacuum", required: true },
  { id: "i2", scope: "interior", min_level: 2, step_order: 70, text: "Shampoo", required: true },
  { id: "e1", scope: "exterior", min_level: 1, step_order: 10, text: "Wash", required: true },
  { id: "e2", scope: "exterior", min_level: 1, step_order: 20, text: "Optional dressing", required: false },
  { id: "c1", scope: "ceramic", min_level: 1, step_order: 10, text: "Panel prep", required: true },
  { id: "old", scope: "interior", min_level: 1, step_order: 5, text: "Retired", required: true, active: false },
];
const ids = (steps) => steps.map((s) => s.id);

test("checklist scopes follow the service category and ceramic flag", () => {
  assert.deepEqual(jobs.checklistScopes("Interior Detail"), ["general", "interior"]);
  assert.deepEqual(jobs.checklistScopes("Exterior Detail"), ["general", "exterior"]);
  assert.deepEqual(jobs.checklistScopes("Combined Package"), ["general", "interior", "exterior"]);
  assert.deepEqual(jobs.checklistScopes("Monthly Detail"), ["general", "interior", "exterior"]);
  assert.deepEqual(jobs.checklistScopes("Exterior Detail", "ceramic"), ["general", "exterior", "ceramic"]);
  assert.deepEqual(jobs.checklistScopes(null), ["general"]);
});

test("steps: level gating, retired steps hidden, general closing steps last", () => {
  assert.deepEqual(ids(jobs.stepsForBooking(STEPS, { category: "Interior Detail", level: 1 })), ["g1", "i1", "g9"]);
  assert.deepEqual(ids(jobs.stepsForBooking(STEPS, { category: "Interior Detail", level: 2 })), ["g1", "i1", "i2", "g9"]);
  assert.deepEqual(
    ids(jobs.stepsForBooking(STEPS, { category: "Combined Package", level: 1, jobFlag: "ceramic" })),
    ["g1", "i1", "e1", "e2", "c1", "g9"]
  );
});

test("completion gate needs every required step and the minimum photos", () => {
  const steps = jobs.stepsForBooking(STEPS, { category: "Exterior Detail", level: 1 });
  const mins = { before: 2, after: 4 };
  const all = { g1: true, e1: true, g9: true };

  assert.deepEqual(jobs.completionProblems({ steps, checked: all, photoCounts: { before: 2, after: 4 }, mins }), []);
  // Optional steps never block.
  assert.ok(!("e2" in all));

  const p = jobs.completionProblems({ steps, checked: { g1: true }, photoCounts: { before: 1, after: 0 }, mins });
  assert.deepEqual(p, [
    "2 checklist steps not checked off",
    "1 more before photo needed (minimum 2)",
    "4 more after photos needed (minimum 4)",
  ]);
});

test("photo minimums are configurable and fall back to 2 before / 4 after", () => {
  assert.deepEqual(jobs.minPhotos(), { before: 2, after: 4 });
  process.env.JOB_MIN_AFTER_PHOTOS = "6";
  process.env.JOB_MIN_BEFORE_PHOTOS = "nonsense";
  try {
    assert.deepEqual(jobs.minPhotos(), { before: 2, after: 6 });
  } finally {
    delete process.env.JOB_MIN_AFTER_PHOTOS;
    delete process.env.JOB_MIN_BEFORE_PHOTOS;
  }
});

test("New York day ranges are DST-safe", () => {
  assert.deepEqual(jobs.nyDayRange("2026-07-15"), {
    startISO: "2026-07-15T04:00:00.000Z",
    endISO: "2026-07-16T04:00:00.000Z",
  });
  // Nov 1, 2026: clocks fall back, so the day is 25 hours long.
  assert.deepEqual(jobs.nyDayRange("2026-11-01"), {
    startISO: "2026-11-01T04:00:00.000Z",
    endISO: "2026-11-02T05:00:00.000Z",
  });
  assert.equal(jobs.nyDayRange("2026-11-10", 14).endISO, "2026-11-24T05:00:00.000Z");
  assert.equal(jobs.isIsoDate("2026-02-30"), false);
  assert.equal(jobs.isIsoDate("2026-02-28"), true);
});

test("photo paths are tied to their booking and kind", () => {
  const b = "0f8b6a2e-1111-4222-8333-444455556666";
  const u = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const path = jobs.photoPath(b, "after", u);
  assert.equal(path, `jobs/${b}/after/${u}.jpg`);
  assert.equal(jobs.isPathForJob(path, b, "after"), true);
  assert.equal(jobs.isPathForJob(path, b, "before"), false);
  assert.equal(jobs.isPathForJob(path.replace(b, "0f8b6a2e-1111-4222-8333-999999999999"), b, "after"), false);
  assert.equal(jobs.isPathForJob(`jobs/${b}/after/../../x.jpg`, b, "after"), false);
});

test("crew view hides prices other than the amount to collect", () => {
  const v = jobs.crewJobView({
    id: "b1", status: "confirmed", total_price: "185.5", base_price: 170, discount_amount: 10,
    customers: { full_name: "Ann", phone: "555", email: "ann@x.com" },
    vehicles: { vehicle_year: 2020, vehicle_make: "Ford", vehicle_model: "F-150", license_plate: "ABC" },
    service_variants: { duration_minutes: 180, services: { category: "Exterior Detail", level: 2 } },
  });
  assert.equal(v.amount_to_collect, 185.5);
  assert.equal(v.vehicle, "2020 Ford F-150");
  assert.equal(v.service_level, 2);
  assert.ok(!("base_price" in v) && !("discount_amount" in v) && !("customer_email" in v));
});

test("payment parsing", () => {
  assert.deepEqual(parsePayment({ amount_collected: "120.005", tip_amount: "", payment_method: "Cash" }).payment, {
    amount_collected: 120.01, tip_amount: 0, payment_method: "Cash", notes: null,
  });
  assert.match(parsePayment({ amount_collected: -1, payment_method: "Cash" }).error, /amount_collected/);
  assert.match(parsePayment({ amount_collected: 10, payment_method: "Zelle" }).error, /payment_method/);
});

function seedBooking(status = "confirmed") {
  return createFakeSupabase({ bookings: [{ id: "b1", status, customer_id: "c1" }], job_payments: [] });
}
const payment = { amount_collected: 150, tip_amount: 20, payment_method: "Cash", notes: null };

test("completeBooking: records payment with the real staff id and runs the cycle hook", async () => {
  cycleCalls.length = 0;
  const sb = seedBooking();
  const r = await completeBooking(sb, { bookingId: "b1", payment, recordedBy: "staff-1", actor: "crew" });
  assert.deepEqual(r, { ok: true });
  assert.equal(sb.tables.bookings[0].status, "completed");
  assert.equal(sb.tables.job_payments.length, 1);
  assert.equal(sb.tables.job_payments[0].recorded_by, "staff-1");
  assert.equal(sb.tables.job_payments[0].tip_amount, 20);
  assert.deepEqual(cycleCalls, [{ id: "b1", actor: "crew" }]);
});

test("completeBooking: refuses completed/cancelled jobs instead of reverting them", async () => {
  for (const status of ["completed", "cancelled"]) {
    const sb = seedBooking(status);
    const r = await completeBooking(sb, { bookingId: "b1", payment });
    assert.equal(r.status, 409);
    assert.equal(sb.tables.bookings[0].status, status);
    assert.equal(sb.tables.job_payments.length, 0);
  }
  const missing = await completeBooking(seedBooking(), { bookingId: "nope", payment });
  assert.equal(missing.status, 404);
});

test("completeBooking: a failed email rolls back to the previous status and removes the payment", async () => {
  const sb = seedBooking("reschedule_requested");
  const r = await completeBooking(sb, {
    bookingId: "b1",
    payment,
    sendEmail: async () => ({ success: false, error: "resend down" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(sb.tables.bookings[0].status, "reschedule_requested");
  assert.equal(sb.tables.job_payments.length, 0);
});
