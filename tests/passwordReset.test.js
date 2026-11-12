// Forgot password: the emailed link sets a new password once, within an hour, and signs in.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.SESSION_SECRET ||= "test-secret";
process.env.SUPABASE_URL ||= "http://fake";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake";
process.env.RESEND_API_KEY ||= "re_test";

const sb = createFakeSupabase({
  staff: [
    { id: "e1", full_name: "Eli Ramos", email: "eli@x.com", role: "employee", active: true, password_hash: "old" },
    { id: "gone", full_name: "Former", email: "old@x.com", role: "employee", active: false, password_hash: "old" },
  ],
});
const sent = [];
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => sb } });
mock.module("../api/_sendEmail.js", { namedExports: { sendBookingEmail: async (m) => { sent.push(m); return { success: true }; } } });

const { default: forgot } = await import("../api/_handlers/staff-forgot-password.js");
const { default: reset } = await import("../api/_handlers/staff-reset-password.js");
const { verifySecret } = await import("../api/_staffAuth.js");

let ip = 0;
function call(handler, body) {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  return handler({ method: "POST", body, headers: { "x-forwarded-for": `10.0.0.${++ip}` } }, res).then(() => res);
}
const row = async (id) => (await sb.from("staff").select("*").eq("id", id).single()).data;
const tokenFrom = (mail) => /reset=([0-9a-f]{64})/.exec(mail.html)[1];

test("same answer whether or not the email exists; only active accounts get a link", async () => {
  for (const email of ["nobody@x.com", "old@x.com"]) {
    const res = await call(forgot, { email });
    assert.deepEqual([res.statusCode, res.body], [200, { ok: true }]);
  }
  assert.equal(sent.length, 0);
  const res = await call(forgot, { email: "ELI@x.com " });
  assert.deepEqual([res.statusCode, res.body], [200, { ok: true }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "eli@x.com");
  const r = await row("e1");
  assert.match(r.reset_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(r.reset_token_hash, tokenFrom(sent[0])); // only the hash is stored
});

test("the link sets the password, signs in, and works only once", async () => {
  const token = tokenFrom(sent[sent.length - 1]);
  assert.equal((await call(reset, { token, password: "short" })).statusCode, 400);
  const ok = await call(reset, { token, password: "new-password-1" });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.body.token.startsWith("v2."));
  assert.equal(ok.body.staff.id, "e1");
  const r = await row("e1");
  assert.equal(verifySecret("new-password-1", r.password_hash), true);
  assert.equal(r.reset_token_hash, null);
  assert.equal((await call(reset, { token, password: "another-pass-2" })).statusCode, 400);
});

test("an expired link is refused", async () => {
  await call(forgot, { email: "eli@x.com" });
  const token = tokenFrom(sent[sent.length - 1]);
  await sb.from("staff").update({ reset_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", "e1");
  assert.equal((await call(reset, { token, password: "new-password-3" })).statusCode, 400);
});
