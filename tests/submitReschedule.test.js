// Customer reschedule submission: only the holder of the booking's reschedule link may move it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";

const sb = createFakeSupabase({
  bookings: [
    { id: "b-open", manage_token: "tok-open", status: "reschedule_requested", scheduled_start: "2026-12-01T15:00:00Z", scheduled_end: "2026-12-01T17:00:00Z", customers: { full_name: "A", email: "a@example.com" } },
    { id: "b-conf", manage_token: "tok-conf", status: "confirmed", scheduled_start: "2026-12-02T15:00:00Z", scheduled_end: "2026-12-02T17:00:00Z", customers: { full_name: "B", email: "b@example.com" } },
  ],
});

mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_subscriptions/cycleState.js", {
  namedExports: { validateCustomerReschedule: async () => ({ ok: true }) },
});
mock.module("../lib/email/sendRescheduleSubmittedEmail.js", {
  namedExports: { sendRescheduleSubmittedEmailCore: async () => ({ success: true }) },
});

const { default: handler } = await import("../api/_handlers/submit-reschedule.js");

function call(body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler({ method: "POST", body }, res).then(() => res);
}

const NEW = { start: "2026-12-05T15:00:00Z", end: "2026-12-05T17:00:00Z" };
const row = async (id) => (await sb.from("bookings").select("*").eq("id", id).single()).data;

test("a booking id alone can no longer move a booking", async () => {
  const res = await call({ bookingId: "b-conf", ...NEW });
  assert.equal(res.statusCode, 400);
  assert.equal((await row("b-conf")).scheduled_start, "2026-12-02T15:00:00Z");
});

test("an unknown token is rejected", async () => {
  const res = await call({ token: "nope", ...NEW });
  assert.equal(res.statusCode, 404);
});

test("a valid token for a booking not awaiting reschedule is rejected", async () => {
  const res = await call({ token: "tok-conf", ...NEW });
  assert.equal(res.statusCode, 404);
  assert.equal((await row("b-conf")).status, "confirmed");
});

test("the link holder can reschedule their own booking", async () => {
  const res = await call({ token: "tok-open", ...NEW });
  assert.equal(res.statusCode, 200);
  const b = await row("b-open");
  assert.equal(b.scheduled_start, NEW.start);
  assert.equal(b.status, "pending");
});
