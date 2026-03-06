#!/usr/bin/env node
/**
 * Subscription onboarding test: booking → create subscription → verify linkage.
 *
 * Run: PUBLIC_BASE_URL=<preview-url> VERCEL_PROTECTION_BYPASS=<token> node scripts/subscription-onboarding-test.js
 *
 * Do NOT modify any existing scripts or endpoints.
 */

const BASE_URL = process.env.PUBLIC_BASE_URL;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;

function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

function getTestSlot() {
  const now = new Date();
  const testDate = new Date(now);
  testDate.setDate(now.getDate() + 3);
  testDate.setHours(14, 0, 0, 0);
  while (testDate.getDay() === 0 || testDate.getDay() === 6) {
    testDate.setDate(testDate.getDate() + 1);
  }
  const start = new Date(testDate);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

function qsBypass() {
  return `?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
}

function fail(message) {
  console.error("FAIL:", message);
  process.exit(1);
}

function logStep(name, status, response) {
  console.log(`\n[test] ${name}`);
  console.log("status:", status);
  console.log("response:", typeof response === "string" ? response : JSON.stringify(response, null, 2));
  if (status >= 500) fail("Server returned 5xx");
}

async function main() {
  assertEnv("PUBLIC_BASE_URL", BASE_URL);
  assertEnv("VERCEL_PROTECTION_BYPASS", BYPASS);

  const base = BASE_URL.replace(/\/$/, "");

  let customer_id, vehicle_id, service_variant_id, manage_token;

  // ----- 1. Seed test data -----
  const seedRes = await fetch(`${base}/api/dev-create-test-booking${qsBypass()}`, { method: "POST" });
  const seedText = await seedRes.text();
  let seedJson;
  try {
    seedJson = JSON.parse(seedText);
  } catch {
    seedJson = { _raw: seedText };
  }
  logStep("seed test data", seedRes.status, seedText);
  if (seedRes.status >= 500) fail("Seed request failed");

  customer_id = seedJson.customer_id;
  vehicle_id = seedJson.vehicle_id;
  service_variant_id = seedJson.service_variant_id;
  manage_token = seedJson.manage_token ?? seedJson.manageToken ?? seedJson.token;

  if (!customer_id || !vehicle_id || !service_variant_id) {
    if (!manage_token) fail("Seed response must include manage_token (or token) when IDs are missing");
    const getUrl = `${base}/api/manage-booking-get${qsBypass()}`;
    let getRes = await fetch(`${getUrl}&token=${encodeURIComponent(manage_token)}`);
    if (getRes.status === 404) {
      getRes = await fetch(`${getUrl}&manage_token=${encodeURIComponent(manage_token)}`);
    }
    if (!getRes.ok) fail("manage-booking-get failed: " + getRes.status);
    const getJson = await getRes.json();
    customer_id = customer_id ?? getJson.customer_id;
    vehicle_id = vehicle_id ?? getJson.vehicle_id;
    service_variant_id = service_variant_id ?? getJson.service_variant_id;
  }

  if (!customer_id || !vehicle_id || !service_variant_id) {
    fail("Could not resolve customer_id, vehicle_id, service_variant_id");
  }

  // ----- 2. Create booking -----
  const { start, end } = getTestSlot();
  const scheduled_start = start.toISOString();
  const scheduled_end = end.toISOString();
  const createBody = {
    customer_id,
    vehicle_id,
    service_variant_id,
    service_address: "11 Grant St, Cohoes, NY 12047",
    scheduled_start,
    scheduled_end
  };
  const createRes = await fetch(`${base}/api/create-booking${qsBypass()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody)
  });
  const createText = await createRes.text();
  let createJson;
  try {
    createJson = JSON.parse(createText);
  } catch {
    createJson = { _raw: createText };
  }
  logStep("create booking", createRes.status, createText);
  if (createRes.status >= 500) fail("Create booking failed");
  if (!createJson.bookingId) fail("Create booking response missing bookingId");
  const bookingId = createJson.bookingId;

  // ----- 3. Create subscription -----
  const subBody = {
    customer_id,
    vehicle_id,
    service_variant_id,
    default_address: "11 Grant St, Cohoes, NY 12047",
    frequency: "monthly",
    activation_booking_id: bookingId
  };
  const subRes = await fetch(`${base}/api/create-subscription${qsBypass()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subBody)
  });
  const subText = await subRes.text();
  let subJson;
  try {
    subJson = JSON.parse(subText);
  } catch {
    subJson = { _raw: subText };
  }
  logStep("create subscription", subRes.status, subText);
  if (subRes.status >= 500) fail("Create subscription failed");
  if (subRes.status !== 200) fail("Expected create-subscription 200, got " + subRes.status);
  if (!subJson.subscription_id) fail("Create subscription response missing subscription_id");

  // ----- 4. Verify database linkage -----
  const verifyRes = await fetch(
    `${base}/api/admin-subscription-by-booking${qsBypass()}&booking_id=${encodeURIComponent(bookingId)}`
  );
  const verifyText = await verifyRes.text();
  let verifyJson;
  try {
    verifyJson = JSON.parse(verifyText);
  } catch {
    verifyJson = { _raw: verifyText };
  }
  logStep("verify subscription", verifyRes.status, verifyText);
  if (verifyRes.status >= 500) fail("Verify subscription request failed");
  if (!verifyJson.subscription_id) fail("Verification response missing subscription_id");
  if (verifyJson.activation_booking_id !== bookingId) {
    fail("activation_booking_id mismatch: expected " + bookingId + ", got " + verifyJson.activation_booking_id);
  }
  if (verifyJson.status !== "pending_activation") {
    fail("Expected status pending_activation, got " + verifyJson.status);
  }

  console.log("\n---");
  console.log("Subscription onboarding test done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
