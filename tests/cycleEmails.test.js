// Renders every maintenance-cycle email against fake data in dry-run mode (nothing is sent)
// and checks dates, prices and links. Run via `npm test` (uses --experimental-test-module-mocks).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createFakeSupabase } from "./fakeSupabase.js";

process.env.EMAIL_DRY_RUN = "1";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test";
process.env.PUBLIC_BASE_URL = "https://book.example.com";

function seed({ reset = false, pushback = false, free = false } = {}) {
  const sb = createFakeSupabase({
    subscription_prices: [{ service_category: "combined", frequency: "monthly", vehicle_size: "oversized", price: 225 }],
    bookings: [{ id: "act", manage_token: "TOKEN123" }]
  });
  const subscription = {
    id: "s1", status: "active", frequency: "monthly", subscription_category: null, discount_reset_required: reset,
    activation_booking_id: "act",
    customers: { full_name: "Jordan Lee", email: "jordan@example.com" },
    vehicles: { vehicle_size: "oversized", vehicle_year: 2022, vehicle_make: "Cadillac", vehicle_model: "Escalade" },
    service_variants: { price: 360, services: { category: "Combined", level: 1 } }
  };
  sb.tables.subscription_cycles = [{
    id: "c1", cycle_index: 6, status: "open", window_start_date: "2026-12-10", window_end_date: "2026-12-16",
    pushback_used: pushback, pushback_end_date: pushback ? "2026-12-23" : null, free_pushback: free,
    subscription_id: "s1", subscriptions: subscription
  }];
  return sb;
}

let current = seed();
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => current } });

const sent = [];
const origLog = console.log;
console.log = (...args) => {
  if (args[0] === "[EMAIL_DRY_RUN]") sent.push(JSON.parse(args[1]));
  else origLog(...args);
};

const { sendCycleOpenEmailCore } = await import("../lib/email/sendCycleOpenEmail.js");
const { sendCycleReminder1EmailCore } = await import("../lib/email/sendCycleReminder1Email.js");
const { sendCycleReminder2EmailCore } = await import("../lib/email/sendCycleReminder2Email.js");
const { sendMissedCycleEmailCore } = await import("../lib/email/sendMissedCycleEmail.js");
const { sendCyclePushbackEmailCore } = await import("../lib/email/sendCyclePushbackEmail.js");

const last = () => sent[sent.length - 1];
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("book-now email: window dates, vehicle, member price, booking link", async () => {
  current = seed();
  await sendCycleOpenEmailCore("c1");
  const e = last();
  assert.equal(e.to, "jordan@example.com");
  assert.match(e.subject, /Thu, Dec 10 – Wed, Dec 16/);
  assert.match(text(e.html), /2022 Cadillac Escalade/);
  assert.match(text(e.html), /member price is \$225/);
  assert.match(e.html, /https:\/\/book\.example\.com\/member-booking\.html\?token=TOKEN123/);
});

test("reminders use the extended end date and the right wording", async () => {
  current = seed({ pushback: true });
  await sendCycleReminder1EmailCore("c1");
  assert.match(last().subject, /by Wed, Dec 23/);
  await sendCycleReminder2EmailCore("c1");
  assert.match(text(last().html), /closes Wednesday, December 23/);
  assert.doesNotMatch(text(last().html), /extend your window once/, "no extension offer after it was used");
  current = seed();
  await sendCycleReminder2EmailCore("c1");
  assert.match(text(last().html), /extend your window once/);
});

test("missed email states full price and returning member price", async () => {
  current = seed({ reset: true });
  await sendMissedCycleEmailCore("c1");
  const t = text(last().html);
  assert.match(t, /full price \(\$360\)/);
  assert.match(t, /Member pricing of \$225/);
});

test("pushback email shows the fee, or no fee when free", async () => {
  current = seed({ pushback: true });
  await sendCyclePushbackEmailCore("c1");
  assert.match(text(last().html), /15% extension fee \(\$33\.75\)/);
  current = seed({ pushback: true, free: true });
  await sendCyclePushbackEmailCore("c1");
  assert.match(text(last().html), /no extension fee/);
});

test("write previews for review", () => {
  const dir = new URL("../tests/.email-previews/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  sent.forEach((e, i) => fs.writeFileSync(new URL(`${i + 1}.html`, dir), `<p><b>To:</b> ${e.to}<br><b>Subject:</b> ${e.subject}</p><hr>${e.html}`));
  assert.ok(sent.length >= 6);
});
