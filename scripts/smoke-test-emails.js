// scripts/smoke-test-emails.js

const BASE = process.env.BASE_URL;
const BYPASS = process.env.BYPASS_TOKEN;

if (!BASE || !BYPASS) {
  console.error("Missing BASE_URL or BYPASS_TOKEN env vars");
  process.exit(1);
}

function url(path) {
  return `${BASE}${path}?x-vercel-protection-bypass=${BYPASS}`;
}

async function post(path, body) {
  const resp = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, body: text };
}

async function createBooking() {
  const resp = await fetch(
    `${BASE}/api/dev-create-test-booking?x-vercel-protection-bypass=${BYPASS}`,
    { method: "POST" }
  );

  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    if (!json.ok) throw new Error("Failed to create test booking: " + text);
    return json;
  } catch {
    throw new Error("Failed to create test booking: " + text);
  }
}

async function runTest(name, fn) {
  console.log("\n===============================");
  console.log("TEST:", name);
  console.log("===============================");
  try {
    await fn();
    console.log("SUCCESS:", name);
  } catch (err) {
    console.error("FAILED:", name, err.message);
  }
}

(async () => {

  await runTest("Customer Reschedule Email", async () => {
    const { bookingId, manageToken } = await createBooking();
    console.log("Booking:", bookingId);
    const res = await post("/api/customer-reschedule-booking", { token: manageToken });
    console.log(res);
  });

  await runTest("Customer Cancel Email", async () => {
    const { bookingId, manageToken } = await createBooking();
    console.log("Booking:", bookingId);
    const res = await post("/api/customer-cancel-booking", { token: manageToken });
    console.log(res);
  });

  await runTest("Admin Confirm Email", async () => {
    const { bookingId } = await createBooking();
    console.log("Booking:", bookingId);
    const res = await post("/api/confirm-booking", { bookingId });
    console.log(res);
  });

  await runTest("Admin Deny Email", async () => {
    const { bookingId } = await createBooking();
    console.log("Booking:", bookingId);
    const res = await post("/api/admin-deny-booking", { bookingId });
    console.log(res);
  });

  await runTest("Admin Complete Email", async () => {
    const { bookingId } = await createBooking();
    console.log("Booking:", bookingId);
    const res = await post("/api/admin-complete-booking", { bookingId });
    console.log(res);
  });

  console.log("\nAll smoke tests finished.");

})();
