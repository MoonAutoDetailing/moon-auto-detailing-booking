// Several people on one job: each tick is saved on its own (nobody undoes someone else's
// step), the job shows as started for everyone, and completion counts every saved tick.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SESSION_SECRET ||= "test-secret";
process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";

const staff = [
  { id: "e1", full_name: "Eli Ramos", email: "e@x.com", role: "employee", active: true },
  { id: "m1", full_name: "Maria Lopez", email: "m@x.com", role: "manager", active: true },
];
const sb = createFakeSupabase({
  staff,
  bookings: [{ id: "b1", status: "confirmed", scheduled_start: "2026-11-20T14:00:00Z", scheduled_end: "2026-11-20T17:00:00Z", service_variants: { services: { category: "Exterior Detail", level: 1 } } }],
  job_completions: [],
  job_photos: [],
  booking_staff: [],
  service_checklists: [
    { id: "s1", scope: "general", min_level: 1, step_order: 10, text: "Confirm", required: true, active: true },
    { id: "s2", scope: "exterior", min_level: 1, step_order: 10, text: "Wash", required: true, active: true },
  ],
});
// Mirrors public.job_check_step (migration 20261114160000): one atomic upsert per tick.
sb.rpc = async (name, { p_booking, p_step, p_on, p_staff }) => {
  assert.equal(name, "job_check_step");
  const { data: row } = await sb.from("job_completions").select("*").eq("booking_id", p_booking).maybeSingle();
  if (!row) {
    await sb.from("job_completions").insert({ booking_id: p_booking, started_at: "now", started_by: p_staff, checklist: p_on ? { [p_step]: true } : {} });
  } else {
    const checklist = { ...row.checklist };
    if (p_on) checklist[p_step] = true; else delete checklist[p_step];
    await sb.from("job_completions").update({ checklist, started_at: row.started_at || "now", started_by: row.started_by || p_staff }).eq("booking_id", p_booking);
  }
  return { error: null };
};
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
const completed = [];
mock.module("../api/_completeBookingCore.js", {
  namedExports: {
    completeBooking: async (_sb, opts) => { completed.push(opts); return { ok: true }; },
    parsePayment: () => ({ payment: { amount_collected: 100, payment_method: "Cash" } }),
  },
});

const { default: staffJob } = await import("../api/_handlers/staff-job.js");
const { default: completeJob } = await import("../api/_handlers/staff-complete-job.js");
const { signStaffToken } = await import("../api/_staffAuth.js");

function call(handler, who, body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  const s = staff.find((x) => x.id === who);
  return handler({ method: "POST", body, query: {}, headers: { "x-staff-session": signStaffToken(s).token } }, res).then(() => res);
}
const stored = async () => (await sb.from("job_completions").select("*").eq("booking_id", "b1").maybeSingle()).data;

test("two people tick different steps: both stay ticked, and the first tick starts the job", async () => {
  await call(staffJob, "e1", { id: "b1", action: "check", step_id: "s1", checked: true });
  await call(staffJob, "m1", { id: "b1", action: "check", step_id: "s2", checked: true });
  const row = await stored();
  assert.deepEqual(row.checklist, { s1: true, s2: true });
  assert.equal(row.started_by, "e1");

  await call(staffJob, "m1", { id: "b1", action: "check", step_id: "s1", checked: false });
  assert.deepEqual((await stored()).checklist, { s2: true });
  await call(staffJob, "e1", { id: "b1", action: "check", step_id: "s1", checked: true });
});

test("an old whole-list save merges instead of wiping other people's ticks", async () => {
  await call(staffJob, "e1", { id: "b1", action: "checklist", checklist: { s1: true } });
  assert.deepEqual((await stored()).checklist, { s1: true, s2: true });
});

test("completion counts every tick saved on the job, not just this phone's", async () => {
  const res = await call(completeJob, "e1", { booking_id: "b1", checklist: {}, amount_collected: 100, payment_method: "Cash" });
  // Photos are still missing, so it's refused — but not for the checklist.
  assert.equal(res.statusCode, 422);
  assert.ok(!res.body.problems.some((p) => /checklist/.test(p)), res.body.problems.join("; "));
  assert.ok(res.body.problems.some((p) => /Before photos still needed/.test(p)));
});
