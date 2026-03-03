/**
 * Smoke test for lifecycle API endpoints.
 * Usage: BASE_URL=https://your-app.vercel.app [BOOKING_ID=uuid] [CANCEL_TOKEN=token] node scripts/smoke-test.js
 */

const BASE_URL = process.env.BASE_URL;
const BYPASS_TOKEN = process.env.BYPASS_TOKEN || "";

async function callApi(path, body) {
  let url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  if (BYPASS_TOKEN) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}x-vercel-protection-bypass=${BYPASS_TOKEN}`;
  }
  console.log("\n---");
  console.log("endpoint:", url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const status = res.status;
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }

    console.log("status:", status);
    console.log("response:", JSON.stringify(json, null, 2));
    return { status, json };
  } catch (err) {
    console.log("error:", err.message);
    return { status: 0, json: null, error: err.message };
  }
}

async function testConfirmBooking(bookingId) {
  console.log("\n[test] confirm booking");
  return callApi("/api/confirm-booking", { bookingId });
}

async function testDenyBooking(bookingId) {
  console.log("\n[test] deny booking");
  return callApi("/api/admin-deny-booking", { bookingId });
}

async function testCompleteBooking(bookingId) {
  console.log("\n[test] complete booking");
  return callApi("/api/admin-complete-booking", { bookingId });
}

async function testCancelBooking(token) {
  console.log("\n[test] cancel booking (customer)");
  return callApi("/api/customer-cancel-booking", { token });
}

async function main() {
  if (!BASE_URL) {
    console.error("Missing BASE_URL. Example: BASE_URL=https://your-app.vercel.app node scripts/smoke-test.js");
    process.exit(1);
  }
  console.log("BASE_URL:", BASE_URL);

  const bookingId = process.env.BOOKING_ID || "test-booking-id";
  const cancelToken = process.env.CANCEL_TOKEN || "test-cancel-token";

  await testConfirmBooking(bookingId);
  await testDenyBooking(bookingId);
  await testCompleteBooking(bookingId);
  await testCancelBooking(cancelToken);

  console.log("\n---");
  console.log("smoke test done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
