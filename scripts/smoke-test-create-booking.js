#!/usr/bin/env node
/**
 * Smoke test for /api/create-booking and rate limit.
 *
 * Run (required env):
 *   BASE_URL="https://moon-auto-detailing-booking-git-se-9eedad-darren-moons-projects.vercel.app" \
 *   BYPASS_TOKEN="yIhbNsfE5kItW33i8uKa2UptIHm5vV6e" \
 *   node scripts/smoke-test-create-booking.js
 *
 * Uses Node 18+ global fetch. Exit code 1 on any failure.
 */

const BASE_URL = process.env.BASE_URL;
const BYPASS_TOKEN = process.env.BYPASS_TOKEN;

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exit(1);
  }
}

function getTomorrow10amAmericaNewYork() {
  const n = new Date();
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const s = f.format(n);
  const [y, m, d] = s.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const start = new Date(`${tomorrowStr}T10:00:00-05:00`);
  if (Number.isNaN(start.getTime())) {
    const startAlt = new Date(`${tomorrowStr}T15:00:00.000Z`);
    return { start: startAlt, end: new Date(startAlt.getTime() + 60 * 60 * 1000) };
  }
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

async function main() {
  assert(BASE_URL, "BASE_URL is required");
  assert(BYPASS_TOKEN, "BYPASS_TOKEN is required");

  let customer_id, vehicle_id, service_variant_id, manage_token;

  // ----- Seed IDs -----
  console.log("\n--- Seed IDs ---");
  const seedRes = await fetch(
    `${BASE_URL}/api/dev-create-test-booking?x-vercel-protection-bypass=${BYPASS_TOKEN}`,
    { method: "POST" }
  );
  console.log("dev-create-test-booking status:", seedRes.status);
  const seedJson = await seedRes.json();

  customer_id = seedJson.customer_id;
  vehicle_id = seedJson.vehicle_id;
  service_variant_id = seedJson.service_variant_id;
  manage_token = seedJson.manage_token ?? seedJson.manageToken ?? seedJson.token;

  if (!customer_id || !vehicle_id || !service_variant_id) {
    assert(manage_token, "Seed response must include manage_token (or token) when customer_id/vehicle_id/service_variant_id are missing");
    const getRes = await fetch(`${BASE_URL}/api/manage-booking-get?token=${encodeURIComponent(manage_token)}&x-vercel-protection-bypass=${BYPASS_TOKEN}`);
    if (getRes.status === 404) {
      const getRes2 = await fetch(`${BASE_URL}/api/manage-booking-get?manage_token=${encodeURIComponent(manage_token)}&x-vercel-protection-bypass=${BYPASS_TOKEN}`);
      assert(getRes2.ok, "manage-booking-get failed with both token and manage_token");
      const getJson = await getRes2.json();
      customer_id = customer_id ?? getJson.customer_id;
      vehicle_id = vehicle_id ?? getJson.vehicle_id;
      service_variant_id = service_variant_id ?? getJson.service_variant_id;
    } else {
      assert(getRes.ok, "manage-booking-get failed: " + getRes.status);
      const getJson = await getRes.json();
      customer_id = customer_id ?? getJson.customer_id;
      vehicle_id = vehicle_id ?? getJson.vehicle_id;
      service_variant_id = service_variant_id ?? getJson.service_variant_id;
    }
  }

  assert(customer_id, "customer_id is required for create-booking; not returned by dev-create-test-booking or manage-booking-get");
  assert(vehicle_id, "vehicle_id is required for create-booking; not returned by dev-create-test-booking or manage-booking-get");
  assert(service_variant_id, "service_variant_id is required for create-booking; not returned by dev-create-test-booking or manage-booking-get");

  console.log("PASS Seed IDs (customer_id, vehicle_id, service_variant_id resolved)");

  // ----- Pick a slot -----
  const { start: slotStart, end: slotEnd } = getTomorrow10amAmericaNewYork();
  const scheduled_start = slotStart.toISOString();
  const scheduled_end = slotEnd.toISOString();
  const service_address = "11 Grant Street, Cohoes, New York, 12047";

  const body = {
    customer_id,
    vehicle_id,
    service_variant_id,
    service_address,
    scheduled_start,
    scheduled_end
  };

  // ----- Call create-booking (success) -----
  console.log("\n--- Create-booking success ---");
  const createRes1 = await fetch(`${BASE_URL}/api/create-booking?x-vercel-protection-bypass=${BYPASS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  console.log("create-booking #1 status:", createRes1.status);
  const createJson1 = await createRes1.json();

  assert(createRes1.status === 200, "Expected 200, got " + createRes1.status);
  assert(createJson1.ok === true, "Expected ok: true");
  assert(typeof createJson1.bookingId === "string", "Expected bookingId string");
  assert(typeof createJson1.manage_token === "string", "Expected manage_token string");
  console.log("PASS Create-booking success (200, ok:true, bookingId + manage_token)");

  // ----- Conflict test -----
  console.log("\n--- Conflict test ---");
  const createRes2 = await fetch(`${BASE_URL}/api/create-booking?x-vercel-protection-bypass=${BYPASS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  console.log("create-booking #2 (same slot) status:", createRes2.status);
  const createJson2 = await createRes2.json();

  assert(createRes2.status === 409, "Expected 409 on conflict, got " + createRes2.status);
  assert(createJson2.ok === false, "Expected ok: false on conflict");
  console.log("PASS Conflict test (409, ok:false)");

  // ----- Rate limit test (6th call = 429) -----
  console.log("\n--- Rate limit test ---");
  for (let i = 3; i <= 6; i++) {
    const res = await fetch(`${BASE_URL}/api/create-booking?x-vercel-protection-bypass=${BYPASS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    console.log(`create-booking #${i} status:`, res.status);
    if (i === 6) {
      assert(res.status === 429, "6th call should return 429, got " + res.status);
      const retryAfter = res.headers.get("Retry-After");
      assert(retryAfter != null && String(retryAfter).length > 0, "429 response must include non-empty Retry-After header");
      console.log("PASS Rate limit test (6th call 429, Retry-After present)");
    }
  }

  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
