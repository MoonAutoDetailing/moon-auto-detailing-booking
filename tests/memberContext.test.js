import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";
import { buildNextService, previewNextWindow } from "../api/_subscriptions/memberContext.js";

const sb = createFakeSupabase({
  subscription_prices: [{ service_category: "combined", frequency: "monthly", vehicle_size: "midsized", price: 200 }]
});

function resolved({ status = "active", cycle = null, booking = null, reset = false, history = [] } = {}) {
  return {
    subscription: {
      id: "s",
      status,
      frequency: "monthly",
      anchor_date: "2026-06-25",
      anchor_index_base: 0,
      discount_reset_required: reset,
      subscription_category: null,
      vehicles: { vehicle_size: "midsized" },
      service_variants: { id: "v", price: 320, duration_minutes: 180, services: { category: "Combined", level: 1 } }
    },
    activeCycle: cycle,
    activeCycleBooking: booking ? { bookings: booking } : null,
    history
  };
}

const cycle = { id: "c5", cycle_index: 5, status: "open", window_start_date: "2026-11-25", window_end_date: "2026-12-01", opens_on: "2026-11-18", pushback_used: false };

test("upcoming before booking opens, bookable after, overdue after the window", async () => {
  assert.equal((await buildNextService(sb, resolved({ cycle }), "2026-11-10")).phase, "upcoming");
  const open = await buildNextService(sb, resolved({ cycle }), "2026-11-20");
  assert.equal(open.phase, "bookable");
  assert.equal(open.pushback.available, false, "pushback only once the window has started");
  assert.equal((await buildNextService(sb, resolved({ cycle }), "2026-11-26")).pushback.available, true);
  assert.equal((await buildNextService(sb, resolved({ cycle }), "2026-12-02")).phase, "overdue");
});

test("member price normally, full price after a miss", async () => {
  assert.equal((await buildNextService(sb, resolved({ cycle }), "2026-11-20")).price.base_price, 200);
  const reset = await buildNextService(sb, resolved({ cycle, reset: true }), "2026-11-20");
  assert.deepEqual([reset.price.base_price, reset.price.reason], [320, "missed_cycle"]);
});

test("booked shows the appointment; no pushback offered", async () => {
  const n = await buildNextService(sb, resolved({
    cycle: { ...cycle, status: "booked" },
    booking: { id: "b", status: "confirmed", scheduled_start: "2026-11-27T16:00:00Z", manage_token: "t" }
  }), "2026-11-26");
  assert.equal(n.phase, "booked");
  assert.equal(n.booking.manage_token, "t");
  assert.equal(n.pushback.available, false);
});

test("no open cycle: preview of the next window from the anchor", async () => {
  const n = await buildNextService(sb, resolved({ history: [{ cycle_index: 5, status: "completed" }] }), "2026-11-20");
  assert.equal(n.phase, "upcoming");
  assert.equal(n.window_start, "2026-12-25");
  assert.equal(n.opens_on, "2026-12-18");
  const past = previewNextWindow(resolved().subscription, [{ cycle_index: 1 }], "2026-11-20");
  assert.equal(past.start, "2026-11-25", "skips windows that already ended");
});

test("paused / cancelled / pending plans are not bookable", async () => {
  for (const status of ["paused", "cancelled", "pending_activation"]) {
    assert.equal((await buildNextService(sb, resolved({ status, cycle }), "2026-11-20")).phase, status);
  }
});
