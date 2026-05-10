#!/usr/bin/env node
/**
 * Smoke test for Admin Book Customer backend APIs.
 *
 * Usage:
 *   BASE_URL=https://your-preview-or-prod-like-url ADMIN_PASSWORD=... \
 *   [VERCEL_PROTECTION_BYPASS=...] [TEST_SERVICE_ADDRESS="11 Grant Street, Cohoes, New York, 12047"] \
 *   node scripts/smoke-test-admin-create-booking.js
 *
 * Validates:
 *   - admin login
 *   - active service variants load
 *   - admin customer create/reuse
 *   - admin vehicle create
 *   - availability slots load
 *   - admin pending booking creation with send_customer_email=false
 *   - admin confirmed booking creation with send_customer_email=false when a second slot is available
 */

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;
const TEST_SERVICE_ADDRESS = process.env.TEST_SERVICE_ADDRESS || "11 Grant Street, Cohoes, New York, 12047";

let adminSession = null;
let bypassCookie = null;
const results = [];

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

function logTest(name, outcome, details = "") {
  const status = outcome === true ? "PASS" : outcome === false ? "FAIL" : "SKIP";
  console.log(`\n--- ${name} ---`);
  console.log(status);
  if (details) console.log(details);
  results.push({ name, status, details });
}

function apiUrl(path) {
  const base = `${BASE_URL}/api/${path}`;
  if (!BYPASS) return base;
  return path.includes("?")
    ? `${base}&x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`
    : `${base}?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
}

function headers(json = true) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  if (bypassCookie) h.cookie = bypassCookie;
  if (adminSession) h["x-admin-session"] = adminSession;
  return h;
}

function responseCookie(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookies.length ? setCookies.join("; ") : (res.headers.get("set-cookie") || null);
}

function appendCookie(cookie) {
  if (!cookie) return;
  bypassCookie = bypassCookie ? `${bypassCookie}; ${cookie}` : cookie;
}

async function ensureBypassCookie() {
  if (!BYPASS) return;
  const url = `${BASE_URL}/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
  const res = await fetch(url);
  appendCookie(responseCookie(res));
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: { _raw: text } };
  }
}

async function adminLogin() {
  const url = apiUrl("admin-login");
  const res = await fetch(url, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  appendCookie(responseCookie(res));
  const { json, text } = await readJson(res);
  if (!res.ok || !json.token) {
    throw new Error(`admin-login failed: endpoint=${url} HTTP ${res.status} response=${text}`);
  }
  adminSession = json.token;
}

async function adminGet(path) {
  const url = apiUrl(path);
  const res = await fetch(url, { method: "GET", headers: headers(false) });
  const { json, text } = await readJson(res);
  return { endpoint: url, status: res.status, ok: res.ok, json, text };
}

async function adminPost(path, body) {
  const url = apiUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body || {})
  });
  const { json, text } = await readJson(res);
  return { endpoint: url, status: res.status, ok: res.ok, json, text };
}

function failureDetails(result) {
  return `Endpoint=${result.endpoint} HTTP ${result.status} response=${result.text}`;
}

function yyyyMmDd(date) {
  return date.toISOString().slice(0, 10);
}

function nextWeekdays(count) {
  const days = [];
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(12, 0, 0, 0);
  while (days.length < count) {
    const day = d.getDay();
    if (day >= 1 && day <= 5) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function loadAvailability(service, minSlots) {
  const days = nextWeekdays(14);
  for (const day of days) {
    const params = new URLSearchParams({
      day: yyyyMmDd(day),
      duration_minutes: String(service.duration_minutes),
      service_address: TEST_SERVICE_ADDRESS,
      service_variant_id: service.service_variant_id
    });
    const res = await adminGet(`get-availability?${params.toString()}`);
    if (!res.ok) {
      console.log(`Availability HTTP ${res.status} for ${yyyyMmDd(day)}: ${res.text}`);
      continue;
    }
    const slots = Array.isArray(res.json.slots) ? res.json.slots : [];
    if (slots.length >= minSlots) return { day: yyyyMmDd(day), slots, json: res.json };
    if (slots.length > 0 && minSlots === 1) return { day: yyyyMmDd(day), slots, json: res.json };
  }
  return null;
}

function bookingBody({ customerId, vehicleId, service, slot, availability, status }) {
  const duration = Number(availability?.json?.solo_effective_duration_minutes || service.duration_minutes);
  const start = new Date(slot);
  const end = new Date(start.getTime() + duration * 60000);
  return {
    customer_id: customerId,
    vehicle_id: vehicleId,
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    service_address: TEST_SERVICE_ADDRESS,
    service_variant_id: service.service_variant_id,
    status,
    send_customer_email: false,
    customer_notes: "Smoke test admin-created booking"
  };
}

async function main() {
  requireEnv("BASE_URL", BASE_URL);
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

  console.log("Admin Create Booking Smoke Test");
  console.log("BASE_URL:", BASE_URL);
  console.log("TEST_SERVICE_ADDRESS:", TEST_SERVICE_ADDRESS);

  await ensureBypassCookie();
  await adminLogin();
  logTest("Admin login", true);

  const servicesRes = await adminGet("admin-service-variants");
  if (!servicesRes.ok || !servicesRes.json?.ok) {
    logTest("Admin service variants", false, failureDetails(servicesRes));
    return finish();
  }
  const service = (servicesRes.json.service_variants || []).find(v => v.service_variant_id && Number(v.duration_minutes) > 0);
  if (!service) {
    logTest("Admin service variants", false, "No usable active service variant returned");
    return finish();
  }
  logTest("Admin service variants", true, `Selected ${service.service_variant_id}`);

  const stamp = Date.now();
  const customerRes = await adminPost("admin-create-customer", {
    full_name: "Smoke Test Admin Booking",
    email: `smoke-admin-booking-${stamp}@example.com`,
    phone: "5185550100"
  });
  if (!customerRes.ok || !customerRes.json?.ok || !customerRes.json.customer?.id) {
    logTest("Admin create/reuse customer", false, failureDetails(customerRes));
    return finish();
  }
  const customerId = customerRes.json.customer.id;
  logTest("Admin create/reuse customer", true, `customer_id=${customerId}`);

  const vehicleRes = await adminPost("admin-create-vehicle", {
    customer_id: customerId,
    year: 2020,
    make: "Smoke",
    model: "Test",
    vehicle_size: service.vehicle_size || "midsized"
  });
  if (!vehicleRes.ok || !vehicleRes.json?.ok || !vehicleRes.json.vehicle?.id) {
    logTest("Admin create vehicle", false, failureDetails(vehicleRes));
    return finish();
  }
  const vehicleId = vehicleRes.json.vehicle.id;
  logTest("Admin create vehicle", true, `vehicle_id=${vehicleId}`);

  const availability = await loadAvailability(service, 1);
  if (!availability) {
    logTest("Availability slots", false, "No available slots found in next 14 weekdays");
    return finish();
  }
  logTest("Availability slots", true, `${availability.slots.length} slot(s) on ${availability.day}`);

  const pendingBody = bookingBody({
    customerId,
    vehicleId,
    service,
    slot: availability.slots[0],
    availability,
    status: "pending"
  });
  const pendingRes = await adminPost("admin-create-booking", pendingBody);
  if (!pendingRes.ok || !pendingRes.json?.ok || pendingRes.json.status !== "pending") {
    logTest("Admin create pending booking", false, failureDetails(pendingRes));
    return finish();
  }
  logTest("Admin create pending booking", true, `bookingId=${pendingRes.json.bookingId}`);

  const confirmedAvailability = await loadAvailability(service, 1);
  const confirmedSlot = confirmedAvailability?.slots?.find(s => s !== availability.slots[0]);
  if (!confirmedSlot) {
    logTest("Admin create confirmed booking", "skip", "No second available slot found after pending booking was created");
    return finish();
  }

  const confirmedBody = bookingBody({
    customerId,
    vehicleId,
    service,
    slot: confirmedSlot,
    availability: confirmedAvailability,
    status: "confirmed"
  });
  const confirmedRes = await adminPost("admin-create-booking", confirmedBody);
  if (!confirmedRes.ok || !confirmedRes.json?.ok || confirmedRes.json.status !== "confirmed") {
    logTest("Admin create confirmed booking", false, failureDetails(confirmedRes));
    return finish();
  }
  logTest("Admin create confirmed booking", true, `bookingId=${confirmedRes.json.bookingId}`);

  finish();
}

function finish() {
  const failed = results.filter(r => r.status === "FAIL");
  const skipped = results.filter(r => r.status === "SKIP");
  console.log("\n=== Summary ===");
  for (const r of results) console.log(`${r.status}: ${r.name}${r.details ? " — " + r.details : ""}`);
  console.log(`\nPassed: ${results.filter(r => r.status === "PASS").length}, Failed: ${failed.length}, Skipped: ${skipped.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
