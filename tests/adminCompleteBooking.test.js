// Admin completion records who worked the job, so tips entered from the admin page reach payroll.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

const sb = createFakeSupabase({
  staff: [
    { id: "e1", full_name: "Eli", active: true },
    { id: "m1", full_name: "Maria", active: true },
    { id: "gone", full_name: "Former", active: false },
  ],
  booking_staff: [],
});
let completeResult = { ok: true };

mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_verifyAdmin.js", { defaultExport: async () => ({ ok: true, admin: { id: "m1", role: "manager" } }) });
mock.module("../api/_completeBookingCore.js", {
  namedExports: {
    completeBooking: async () => completeResult,
    parsePayment: (b) => ({ payment: { amount_collected: b.amount_collected, tip_amount: b.tip_amount, payment_method: b.payment_method } }),
  },
});

const { default: handler } = await import("../api/_handlers/admin-complete-booking.js");

function call(body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler({ method: "POST", body, headers: {} }, res).then(() => res);
}
const crewFor = async (id) => (await sb.from("booking_staff").select("*").eq("booking_id", id)).data.map((r) => r.staff_id).sort();

test("records the active people picked as having worked the job", async () => {
  const res = await call({ bookingId: "b1", amount_collected: 200, tip_amount: 20, payment_method: "Cash", worked_by: ["e1", "m1", "gone", "nobody"] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await crewFor("b1"), ["e1", "m1"]);
});

test("records no crew when none are picked", async () => {
  const res = await call({ bookingId: "b2", amount_collected: 120, tip_amount: 0, payment_method: "Venmo" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await crewFor("b2"), []);
});

test("records no crew when completion fails", async () => {
  completeResult = { ok: false, status: 409, error: "Booking is already completed" };
  const res = await call({ bookingId: "b3", amount_collected: 120, tip_amount: 10, payment_method: "Cash", worked_by: ["e1"] });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(await crewFor("b3"), []);
  completeResult = { ok: true };
});
