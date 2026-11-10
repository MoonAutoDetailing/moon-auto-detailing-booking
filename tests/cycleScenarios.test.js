import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, createSendSpy } from "./fakeSupabase.js";
import { runGenerateCycles, runCheckMissedCycles, runSendReminders } from "../api/_subscriptions/cycleJobs.js";
import {
  onBookingCancelled,
  onBookingCompleted,
  validateCustomerReschedule,
  onAdminReschedule,
  linkBookingToCycle,
  voidOpenCycles,
  resolveMemberPrice,
  validateMemberSlot,
  resumeSubscription
} from "../api/_subscriptions/cycleState.js";

// 11am New York on a given date, as stored in bookings.scheduled_start.
const at11 = (day) => `${day}T16:00:00+00:00`;

function world({ frequency = "monthly", anchor = "2026-11-02", status = "active", cycles = [], bookings = [], links = [], subs = [], vehicles = [] } = {}) {
  const sub = {
    id: "sub1",
    customer_id: "cust1",
    vehicle_id: "veh1",
    service_variant_id: "var1",
    frequency,
    status,
    anchor_date: anchor,
    anchor_index_base: 0,
    activation_booking_id: "bk-act",
    discount_reset_required: false,
    completed_cycles_count: 1,
    missed_cycles_count: 0,
    subscription_category: "combined"
  };
  return createFakeSupabase({
    subscriptions: [sub, ...subs],
    subscription_cycles: [
      { id: "cyc0", subscription_id: "sub1", cycle_index: 0, status: "completed", window_start_date: anchor, window_end_date: anchor },
      ...cycles
    ],
    subscription_cycle_bookings: links,
    bookings: [
      { id: "bk-act", customer_id: "cust1", vehicle_id: "veh1", scheduled_start: at11(anchor), status: "completed", base_price: 200, service_variant_id: "var1" },
      ...bookings
    ],
    vehicles: [{ id: "veh1", license_plate: "ABC123", vehicle_make: "Honda", vehicle_model: "Civic" }, ...vehicles],
    service_variants: [{ id: "var1", price: 200, vehicle_size: "midsized", service: { category: "Combined" } }],
    subscription_prices: [{ service_category: "combined", frequency: "monthly", vehicle_size: "midsized", price: 160 }],
    subscription_cycle_audit: []
  });
}

async function runAll(sb, today, spy) {
  await runGenerateCycles({ sb, today, send: spy.send });
  await runCheckMissedCycles({ sb, today, send: spy.send });
  await runSendReminders({ sb, today, send: spy.send });
}

const cyclesOf = (sb) => sb.tables.subscription_cycles.filter((c) => c.cycle_index > 0);
const sub1 = (sb) => sb.tables.subscriptions.find((s) => s.id === "sub1");

// 1–3: not due yet → no cycle, no email
for (const [frequency, anchor, today] of [
  ["biweekly", "2026-11-02", "2026-11-05"],
  ["monthly", "2026-11-02", "2026-11-20"],
  ["quarterly", "2026-10-01", "2026-11-20"]
]) {
  test(`1-3. ${frequency} subscriber not due yet gets nothing`, async () => {
    const sb = world({ frequency, anchor });
    const spy = createSendSpy();
    await runAll(sb, today, spy);
    assert.equal(cyclesOf(sb).length, 0);
    assert.deepEqual(spy.sent, []);
  });
}

test("4. booking opens 7 days before the window: one cycle, one email, even if cron reruns", async () => {
  const sb = world({ frequency: "monthly", anchor: "2026-11-02" }); // next window Wed Dec 2 – Tue Dec 8
  const spy = createSendSpy();
  await runAll(sb, "2026-11-24", spy);
  assert.equal(cyclesOf(sb).length, 0, "not yet (opens Nov 25)");
  for (let i = 0; i < 3; i++) await runAll(sb, "2026-11-25", spy);
  const [cycle] = cyclesOf(sb);
  assert.equal(cycle.window_start_date, "2026-12-02");
  assert.equal(cycle.window_end_date, "2026-12-08");
  assert.equal(cycle.opens_on, "2026-11-25");
  assert.deepEqual(spy.sent.map((s) => s.type), ["open"]);
});

test("5. already booked: no reminders, never marked missed", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "booked", window_start_date: "2026-12-02", window_end_date: "2026-12-08", opens_on: "2026-11-25", open_email_sent_at: "x" }],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh1", scheduled_start: at11("2026-12-03"), status: "confirmed" }],
    links: [{ id: "l1", cycle_id: "c1", booking_id: "b1", price_mode: "discounted" }]
  });
  const spy = createSendSpy();
  for (const day of ["2026-12-05", "2026-12-07", "2026-12-09", "2026-12-15"]) await runAll(sb, day, spy);
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "booked");
  assert.deepEqual(spy.sent, []);
});

test("6. completing the cycle booking completes the cycle and restores a discount paid at full price", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "booked", window_start_date: "2026-12-02", window_end_date: "2026-12-08" }],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh1", scheduled_start: at11("2026-12-03"), status: "completed" }],
    links: [{ id: "l1", cycle_id: "c1", booking_id: "b1", price_mode: "full" }]
  });
  sub1(sb).discount_reset_required = true;
  await onBookingCompleted(sb, "b1");
  await onBookingCompleted(sb, "b1"); // repeat is harmless
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "completed");
  assert.equal(sub1(sb).completed_cycles_count, 2); // activation cycle 0 + cycle 1
  assert.equal(sub1(sb).discount_reset_required, false);
});

test("7a. customer cancels: cycle reopens with original window; business cancel adds a free extension", async () => {
  const base = {
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "booked", window_start_date: "2026-12-02", window_end_date: "2026-12-08" }],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh1", scheduled_start: at11("2026-12-03"), status: "cancelled" }],
    links: [{ id: "l1", cycle_id: "c1", booking_id: "b1", price_mode: "discounted" }]
  };
  let sb = world(base);
  await onBookingCancelled(sb, "b1", { today: "2026-12-01" });
  let c1 = sb.tables.subscription_cycles.find((c) => c.id === "c1");
  assert.equal(c1.status, "open");
  assert.ok(!c1.pushback_used);
  assert.ok(sb.tables.subscription_cycle_bookings[0].released_at);

  sb = world(base);
  await onBookingCancelled(sb, "b1", { today: "2026-12-07", businessInitiated: true });
  c1 = sb.tables.subscription_cycles.find((c) => c.id === "c1");
  assert.equal(c1.status, "open");
  assert.equal(c1.free_pushback, true);
  assert.equal(c1.pushback_end_date, "2026-12-15"); // Tue Dec 8 + 5 business days
});

test("7b. reschedules: customer can't leave the window; admin can and the window extends to cover it", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "booked", window_start_date: "2026-12-02", window_end_date: "2026-12-08" }],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh1", scheduled_start: at11("2026-12-03"), status: "confirmed" }],
    links: [{ id: "l1", cycle_id: "c1", booking_id: "b1", price_mode: "discounted" }]
  });
  assert.equal((await validateCustomerReschedule(sb, "b1", at11("2026-12-07"))).ok, true);
  assert.equal((await validateCustomerReschedule(sb, "b1", at11("2026-12-10"))).ok, false);
  await onAdminReschedule(sb, "b1", at11("2026-12-18"), { today: "2026-12-01" });
  const c1 = sb.tables.subscription_cycles.find((c) => c.id === "c1");
  assert.equal(c1.pushback_end_date, "2026-12-18");
  const spy = createSendSpy();
  await runAll(sb, "2026-12-16", spy);
  assert.equal(c1.status, "booked");
  assert.deepEqual(spy.sent, []);
});

test("8. pushback used: reminders and missed follow the pushback end", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08", pushback_used: true, pushback_end_date: "2026-12-15", open_email_sent_at: "x" }]
  });
  const spy = createSendSpy();
  for (const day of ["2026-12-05", "2026-12-07", "2026-12-09"]) await runAll(sb, day, spy);
  assert.deepEqual(spy.sent, [], "no reminders against the original Dec 8 end");
  await runAll(sb, "2026-12-12", spy);
  await runAll(sb, "2026-12-14", spy);
  await runAll(sb, "2026-12-15", spy);
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "open");
  await runAll(sb, "2026-12-16", spy);
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "missed");
  assert.deepEqual(spy.sent.map((s) => s.type), ["reminder1", "reminder2", "missed"]);
});

test("9a. missed: marked once, emailed once, counted, discount reset", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08", open_email_sent_at: "x" }]
  });
  const spy = createSendSpy();
  for (let i = 0; i < 3; i++) {
    await runCheckMissedCycles({ sb, today: "2026-12-09", send: spy.send });
  }
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "missed");
  assert.equal(spy.sent.filter((s) => s.type === "missed").length, 1);
  assert.equal(sub1(sb).missed_cycles_count, 1);
  assert.equal(sub1(sb).discount_reset_required, true);
});

test("9b. member booked through the public form (unlinked): linked instead of missed or reminded", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08", open_email_sent_at: "x" }],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh9", scheduled_start: at11("2026-12-04"), status: "confirmed" }]
  });
  const spy = createSendSpy();
  await runAll(sb, "2026-12-05", spy); // reminder 1 day → finds the booking instead
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "booked");
  assert.equal(sb.tables.subscription_cycle_bookings[0].booking_id, "b1");
  await runAll(sb, "2026-12-09", spy);
  assert.deepEqual(spy.sent, []);
});

test("10. paused or cancelled subscription: open cycle voided, no emails, nothing generated", async () => {
  for (const status of ["paused", "cancelled"]) {
    const sb = world({
      status,
      cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08" }]
    });
    const spy = createSendSpy();
    for (const day of ["2026-12-05", "2026-12-07", "2026-12-09", "2027-01-05"]) await runAll(sb, day, spy);
    assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "void");
    assert.equal(cyclesOf(sb).length, 1);
    assert.deepEqual(spy.sent, []);
    assert.equal(sub1(sb).discount_reset_required, false);
  }
});

test("10b. resume re-anchors so the next window is in the future, not back-filled", async () => {
  const sb = world({ status: "paused", anchor: "2026-03-02" });
  await voidOpenCycles(sb, "sub1");
  const res = await resumeSubscription(sb, sub1(sb), { today: "2026-11-20" });
  assert.equal(sub1(sb).status, "active");
  assert.equal(res.next_window.start, "2026-12-21"); // Nov 20 + 1 month = Sun Dec 20 → Mon Dec 21
  const spy = createSendSpy();
  await runAll(sb, "2026-11-21", spy);
  assert.equal(cyclesOf(sb).length, 0);
});

test("11a. two subscriptions on different vehicles: booking links to the matching vehicle's cycle", async () => {
  const sb = world({
    subs: [{ id: "sub2", customer_id: "cust1", vehicle_id: "veh2", frequency: "monthly", status: "active", anchor_date: "2026-11-02", activation_booking_id: "bk-act2", discount_reset_required: false }],
    vehicles: [{ id: "veh2", license_plate: "XYZ999", vehicle_make: "Ford", vehicle_model: "F-150" }, { id: "veh2-copy", license_plate: "xyz 999", vehicle_make: "Ford", vehicle_model: "F-150" }],
    cycles: [
      { id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08", open_email_sent_at: "x" },
      { id: "c2", subscription_id: "sub2", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08", open_email_sent_at: "x" }
    ],
    bookings: [{ id: "b1", customer_id: "cust1", vehicle_id: "veh2-copy", scheduled_start: at11("2026-12-03"), status: "confirmed" }]
  });
  const spy = createSendSpy();
  await runAll(sb, "2026-12-05", spy);
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c2").status, "booked");
  assert.equal(sb.tables.subscription_cycles.find((c) => c.id === "c1").status, "open");
  assert.deepEqual(spy.sent.map((s) => s.type), ["reminder1"]); // only the unbooked car is reminded
});

test("11b. old anchor with gaps: past windows are skipped, never back-filled", async () => {
  const sb = world({ frequency: "monthly", anchor: "2026-04-28" }); // history only cycle 0
  const spy = createSendSpy();
  await runAll(sb, "2026-11-25", spy);
  const created = cyclesOf(sb);
  assert.equal(created.length, 1);
  assert.equal(created[0].window_start_date, "2026-11-30"); // Nov 28 (Sat) → Mon Nov 30
  assert.deepEqual(spy.sent.map((s) => s.type), ["open"]);
  assert.equal(sb.tables.subscription_cycles.filter((c) => c.status === "missed").length, 0);
});

test("12. running every job repeatedly over a whole cycle never duplicates rows or emails", async () => {
  const sb = world({ frequency: "biweekly", anchor: "2026-11-02" }); // windows Nov 16–20, Nov 30–Dec 4...
  const spy = createSendSpy();
  for (let d = 9; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    for (let i = 0; i < 3; i++) await runAll(sb, day, spy);
  }
  const counts = spy.sent.reduce((m, s) => ({ ...m, [`${s.type}:${s.cycleId}`]: (m[`${s.type}:${s.cycleId}`] || 0) + 1 }), {});
  assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
  const indexes = cyclesOf(sb).map((c) => c.cycle_index);
  assert.equal(new Set(indexes).size, indexes.length);
  // cycle 1 (Nov 16–20) missed once; cycle 2 opened Nov 23 for Nov 30
  assert.deepEqual(cyclesOf(sb).map((c) => [c.cycle_index, c.status]).sort(), [[1, "missed"], [2, "open"]]);
  assert.deepEqual(spy.sent.map((s) => s.type), ["open", "reminder1", "reminder2", "missed", "open"]);
});

test("activation: first completed service anchors in New York time and counts as cycle 1", async () => {
  const sb = createFakeSupabase({
    subscriptions: [{ id: "s", customer_id: "c", status: "pending_activation", frequency: "monthly", activation_booking_id: "b", anchor_date: null, discount_reset_required: false }],
    bookings: [{ id: "b", customer_id: "c", scheduled_start: "2026-11-11T00:30:00+00:00", status: "completed" }], // 7:30pm Nov 10 NY
    subscription_cycles: [],
    subscription_cycle_bookings: [],
    subscription_cycle_audit: []
  });
  await onBookingCompleted(sb, "b");
  await onBookingCompleted(sb, "b");
  const s = sb.tables.subscriptions[0];
  assert.equal(s.status, "active");
  assert.equal(s.anchor_date, "2026-11-10");
  assert.equal(s.completed_cycles_count, 1);
  assert.equal(sb.tables.subscription_cycles.length, 1);
});

test("email failure is not recorded as sent and is retried the next day", async () => {
  const sb = world({ frequency: "monthly", anchor: "2026-11-02" });
  const failing = createSendSpy({ fail: true });
  await runGenerateCycles({ sb, today: "2026-11-25", send: failing.send });
  assert.equal(cyclesOf(sb)[0].open_email_sent_at, undefined);
  const ok = createSendSpy();
  await runGenerateCycles({ sb, today: "2026-11-26", send: ok.send });
  assert.deepEqual(ok.sent.map((s) => s.type), ["open"]);
});

test("member pricing and slot rules", async () => {
  const sb = world();
  const variant = sb.tables.service_variants[0];
  assert.equal((await resolveMemberPrice(sb, sub1(sb), variant)).base_price, 160);
  sub1(sb).discount_reset_required = true;
  const reset = await resolveMemberPrice(sb, sub1(sb), variant);
  assert.deepEqual([reset.base_price, reset.reason], [200, "missed_cycle"]);
  const cycle = { window_start_date: "2026-12-02", window_end_date: "2026-12-08" };
  const now = new Date("2026-12-02T15:00:00Z");
  assert.equal(validateMemberSlot(cycle, at11("2026-12-04"), now).ok, true);
  assert.equal(validateMemberSlot(cycle, at11("2026-12-02"), now).ok, false, "under 24h");
  assert.equal(validateMemberSlot(cycle, at11("2026-12-09"), now).ok, false, "after window");
});

test("linking the same booking twice is rejected", async () => {
  const sb = world({
    cycles: [{ id: "c1", subscription_id: "sub1", cycle_index: 1, status: "open", window_start_date: "2026-12-02", window_end_date: "2026-12-08" }],
    bookings: [{ id: "b1", customer_id: "cust1", scheduled_start: at11("2026-12-03"), status: "confirmed" }]
  });
  const cycle = sb.tables.subscription_cycles.find((c) => c.id === "c1");
  assert.equal((await linkBookingToCycle(sb, { subscription: sub1(sb), cycle, bookingId: "b1", priceMode: "discounted" })).ok, true);
  assert.equal((await linkBookingToCycle(sb, { subscription: sub1(sb), cycle, bookingId: "b1", priceMode: "discounted" })).ok, false);
});
