import { test } from "node:test";
import assert from "node:assert/strict";
import { planRepair, sameVehicle, toSql } from "../scripts/subscription-repair.js";

test("vehicle matching tolerates typos but not different cars", () => {
  assert.ok(sameVehicle({ id: "a", mm_key: "cadillac escalade" }, { id: "b", mm_key: "cadillac escilade" }));
  assert.ok(sameVehicle({ id: "a", mm_key: "infiniti qx60" }, { id: "b", mm_key: "infinity qx60" }));
  assert.ok(sameVehicle({ id: "a", plate_key: "LLC7534", mm_key: "volvo v60" }, { id: "b", plate_key: "LLC7534", mm_key: "volvo xc60" }));
  assert.ok(!sameVehicle({ id: "a", mm_key: "ford f150" }, { id: "b", mm_key: "ford explorer" }));
  assert.ok(!sameVehicle({ id: "a", mm_key: "gmc 2500" }, { id: "b", mm_key: "cadillac escalade" }));
});

const snapshot = {
  subscriptions: [
    { id: "s1", customer_id: "c", vehicle_id: "v1", frequency: "monthly", status: "active", anchor_date: "2026-06-10", discount_reset_required: true, completed_cycles_count: 0, missed_cycles_count: 0 },
    { id: "s2", customer_id: "c", vehicle_id: "v2", frequency: "monthly", status: "active", anchor_date: "2026-06-25", discount_reset_required: true, completed_cycles_count: 0, missed_cycles_count: 0 }
  ],
  cycles: [
    { id: "a1", subscription_id: "s1", cycle_index: 1, status: "missed", window_start_date: "2026-07-10", window_end_date: "2026-07-17" },
    { id: "a2", subscription_id: "s1", cycle_index: 2, status: "missed", window_start_date: "2026-08-10", window_end_date: "2026-08-17" },
    { id: "a3", subscription_id: "s1", cycle_index: 3, status: "open", window_start_date: "2026-11-09", window_end_date: "2026-11-24" },
    { id: "b1", subscription_id: "s2", cycle_index: 1, status: "missed", window_start_date: "2026-08-25", window_end_date: "2026-09-01" }
  ],
  bookings: [
    { id: "k0", customer_id: "c", vehicle_id: "v1", scheduled_start: "2026-06-10T15:00:00Z", status: "completed", base_price: 260, service_variant_id: "x" },
    { id: "k1", customer_id: "c", vehicle_id: "v1b", scheduled_start: "2026-08-19T15:00:00Z", status: "completed", base_price: 225, service_variant_id: "x" },
    { id: "k2", customer_id: "c", vehicle_id: "v2", scheduled_start: "2026-08-19T17:00:00Z", status: "completed", base_price: 225, service_variant_id: "x" },
    { id: "k9", customer_id: "c", vehicle_id: "v1", scheduled_start: "2026-08-20T17:00:00Z", status: "cancelled", base_price: 225, service_variant_id: "x" }
  ],
  vehicles: [
    { id: "v1", mm_key: "cadillac escalade" }, { id: "v1b", mm_key: "cadillac escilade" }, { id: "v2", mm_key: "gmc 2500" }
  ],
  variants: [{ id: "x", price: 240 }]
};

test("planner: matches each car's bookings, forgives misses, keeps in-progress window end", () => {
  const [p1, p2] = planRepair(snapshot, "2026-11-10");
  const byIdx = (p) => Object.fromEntries(p.rows.map((r) => [r.cycle_index, r]));
  const a = byIdx(p1);
  assert.equal(a[0].after.status, "completed");
  assert.equal(a[1].after.status, "void");
  assert.equal(a[2].after.status, "completed");
  assert.equal(a[2].booking.id, "k1"); // typo'd vehicle still matches, cancelled booking ignored
  assert.equal(a[2].price_mode, "discounted");
  assert.equal(a[3].after.status, "open");
  assert.equal(a[3].after.end, "2026-11-24"); // told Nov 24, not shortened
  assert.equal(p1.subscriptionAfter.completed_cycles_count, 2);
  assert.equal(p1.subscriptionAfter.discount_reset_required, false);
  const b = byIdx(p2);
  assert.equal(b[1].booking.id, "k2"); // the GMC booking goes to the GMC plan
  assert.ok(toSql([p1, p2]).startsWith("begin;"));
});
