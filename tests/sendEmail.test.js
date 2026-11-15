import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.RESEND_API_KEY = "test-key";
delete process.env.EMAIL_DRY_RUN;

let nextResult;
class FakeResend {
  constructor() {
    this.emails = { send: async () => nextResult };
  }
}
mock.module("resend", { namedExports: { Resend: FakeResend } });

const { sendBookingEmail } = await import("../api/_sendEmail.js");
const msg = { to: "a@example.com", subject: "Hi", html: "<p>Hi</p>" };

test("a Resend error result is reported as a failure, not a send", async () => {
  nextResult = { data: null, error: { name: "validation_error", message: "Invalid `to` field" } };
  const r = await sendBookingEmail(msg);
  assert.equal(r.success, false);
  assert.equal(r.error.name, "validation_error");
});

test("a successful send returns the Resend id", async () => {
  nextResult = { data: { id: "em_123" }, error: null };
  const r = await sendBookingEmail(msg);
  assert.deepEqual(r, { success: true, id: "em_123" });
});
