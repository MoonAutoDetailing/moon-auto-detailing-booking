#!/usr/bin/env node
/**
 * Full booking lifecycle workflow test.
 *
 * Run: PUBLIC_BASE_URL=<preview-url> VERCEL_PROTECTION_BYPASS=<token> ADMIN_SECRET=<secret> node scripts/workflow-test.js
 *
 * Validates: create → confirm → complete (Booking A); create → confirm → cancel (Booking B).
 * Exits with code 1 if any request returns 500.
 */

const BASE_URL = process.env.PUBLIC_BASE_URL;
const BYPASS_TOKEN = process.env.VERCEL_PROTECTION_BYPASS;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

function getTestSlot(dayOffset = 3) {
  const now = new Date();
  const testDate = new Date(now);
  testDate.setDate(now.getDate() + dayOffset);
  testDate.setHours(14, 0, 0, 0);
  while (testDate.getDay() === 0 || testDate.getDay() === 6) {
    testDate.setDate(testDate.getDate() + 1);
  }
  const start = new Date(testDate);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

function qsBypass() {
  return BYPASS_TOKEN ? `?x-vercel-protection-bypass=${encodeURIComponent(BYPASS_TOKEN)}` : "";
}

function commonHeaders() {
  const h = { "Content-Type": "application/json" };
  if (ADMIN_SECRET) h["x-admin-secret"] = ADMIN_SECRET;
  return h;
}

async function createBooking(customer_id, vehicle_id, service_variant_id, scheduled_start, scheduled_end, service_address) {
  const url = `${BASE_URL.replace(/\/$/, "")}/api/create-booking${qsBypass()}`;
  const body = {
    customer_id,
    vehicle_id,
    service_variant_id,
    service_address,
    scheduled_start,
    scheduled_end
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

async function adminConfirm(booking_id) {
  const url = `${BASE_URL.replace(/\/$/, "")}/api/confirm-booking${qsBypass()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: commonHeaders(),
    body: JSON.stringify({ booking_id, bookingId: booking_id })
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

async function adminComplete(booking_id) {
  const url = `${BASE_URL.replace(/\/$/, "")}/api/admin-complete-booking${qsBypass()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: commonHeaders(),
    body: JSON.stringify({ booking_id })
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

async function customerCancel(token) {
  const url = `${BASE_URL.replace(/\/$/, "")}/api/customer-cancel-booking${qsBypass()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

function logStep(name, res) {
  console.log(`\n[test] ${name}`);
  console.log("status:", res.status);
  console.log("response:", res.text);
  if (res.status >= 500) {
    console.error("FAIL: 500 Server Error");
    process.exit(1);
  }
}

async function main() {
  assertEnv("PUBLIC_BASE_URL", BASE_URL);
  assertEnv("VERCEL_PROTECTION_BYPASS", BYPASS_TOKEN);
  assertEnv("ADMIN_SECRET", ADMIN_SECRET);

  let customer_id, vehicle_id, service_variant_id, manage_token;

  console.log("\n--- Seed IDs ---");
  const seedRes = await fetch(
    `${BASE_URL.replace(/\/$/, "")}/api/dev-create-test-booking${qsBypass()}`,
    { method: "POST" }
  );
  const seedJson = await seedRes.json();
  customer_id = seedJson.customer_id;
  vehicle_id = seedJson.vehicle_id;
  service_variant_id = seedJson.service_variant_id;
  manage_token = seedJson.manage_token ?? seedJson.manageToken ?? seedJson.token;

  if (!customer_id || !vehicle_id || !service_variant_id) {
    if (!manage_token) {
      console.error("Seed response must include manage_token when customer_id/vehicle_id/service_variant_id are missing");
      process.exit(1);
    }
    const getUrl = `${BASE_URL.replace(/\/$/, "")}/api/manage-booking-get${qsBypass()}`;
    let getRes = await fetch(`${getUrl}&token=${encodeURIComponent(manage_token)}`);
    if (getRes.status === 404) {
      getRes = await fetch(`${getUrl}&manage_token=${encodeURIComponent(manage_token)}`);
    }
    if (!getRes.ok) {
      console.error("manage-booking-get failed:", getRes.status);
      process.exit(1);
    }
    const getJson = await getRes.json();
    customer_id = customer_id ?? getJson.customer_id;
    vehicle_id = vehicle_id ?? getJson.vehicle_id;
    service_variant_id = service_variant_id ?? getJson.service_variant_id;
  }

  if (!customer_id || !vehicle_id || !service_variant_id) {
    console.error("Could not resolve customer_id, vehicle_id, service_variant_id");
    process.exit(1);
  }
  console.log("Seed IDs resolved (customer_id, vehicle_id, service_variant_id)");

  const service_address = "11 Grant Street, Cohoes, New York, 12047";

  // STEP 1: Create Booking A
  const slotA = getTestSlot(3);
  const scheduled_start_a = slotA.start.toISOString();
  const scheduled_end_a = slotA.end.toISOString();
  const createA = await createBooking(
    customer_id,
    vehicle_id,
    service_variant_id,
    scheduled_start_a,
    scheduled_end_a,
    service_address
  );
  logStep("create booking A", createA);
  if (createA.status !== 200 || !createA.json?.bookingId) {
    console.error("FAIL: create booking A did not return 200 with bookingId");
    process.exit(1);
  }
  const bookingIdA = createA.json.bookingId;

  // STEP 2: Confirm Booking A (admin)
  const confirmA = await adminConfirm(bookingIdA);
  logStep("confirm booking A", confirmA);

  // STEP 3: Complete Booking A (admin)
  const completeA = await adminComplete(bookingIdA);
  logStep("complete booking A", completeA);

  // STEP 4: Create Booking B (new slot)
  const slotB = getTestSlot(4);
  const scheduled_start_b = slotB.start.toISOString();
  const scheduled_end_b = slotB.end.toISOString();
  const createB = await createBooking(
    customer_id,
    vehicle_id,
    service_variant_id,
    scheduled_start_b,
    scheduled_end_b,
    service_address
  );
  logStep("create booking B", createB);
  if (createB.status !== 200 || !createB.json?.bookingId) {
    console.error("FAIL: create booking B did not return 200 with bookingId");
    process.exit(1);
  }
  const bookingIdB = createB.json.bookingId;
  const manageTokenB = createB.json.manage_token ?? createB.json.manageToken;
  if (!manageTokenB) {
    console.error("FAIL: create booking B did not return manage_token");
    process.exit(1);
  }

  // STEP 5: Confirm Booking B (admin)
  const confirmB = await adminConfirm(bookingIdB);
  logStep("confirm booking B", confirmB);

  // STEP 6: Cancel Booking B (customer) — use manage_token
  const cancelB = await customerCancel(manageTokenB);
  logStep("cancel booking B", cancelB);

  console.log("\n---");
  console.log("Workflow test done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
