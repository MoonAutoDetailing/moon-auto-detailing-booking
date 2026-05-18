#!/usr/bin/env node
/**
 * Focused smoke test for admin manual reschedule.
 *
 * Usage:
 *   BASE_URL=https://your-preview-or-prod-like-url ADMIN_PASSWORD=... \
 *   [VERCEL_PROTECTION_BYPASS=...] [TEST_SERVICE_ADDRESS="11 Grant Street, Cohoes, New York, 12047"] \
 *   node scripts/smoke-test-admin-reschedule-booking.js
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
  const res = await fetch(apiUrl("admin-login"), {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  appendCookie(responseCookie(res));
  const { json, text } = await readJson(res);
  if (!res.ok || !json.token) {
    throw new Error(`admin-login failed: HTTP ${res.status} response=${text}`);
  }
  adminSession = json.token;
}

async function adminGet(path) {
  const endpoint = apiUrl(path);
  const res = await fetch(endpoint, { method: "GET", headers: headers(false) });
  const { json, text } = await readJson(res);
  return { endpoint, status: res.status, ok: res.ok, json, text };
}

async function adminPost(path, body) {
  const endpoint = apiUrl(path);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body || {})
  });
  const { json, text } = await readJson(res);
  return { endpoint, status: res.status, ok: res.ok, json, text };
}

function failureDetails(result) {
  return `Endpoint=${result.endpoint} HTTP ${result.status} response=${result.text}`;
}

function yyyyMmDd(date) {
  return date.toISOString().slice(0, 10);
}

function nextWeekdays(count, startOffsetDays = 45) {
  const days = [];
  const d = new Date();
  d.setDate(d.getDate() + startOffsetDays);
  d.setHours(12, 0, 0, 0);
  while (days.length < count) {
    const day = d.getDay();
    if (day >= 1 && day <= 5) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function isSlotConflict(result) {
  const text = `${result.text || ""} ${result.json?.message || ""} ${result.json?.error || ""}`.toLowerCase();
  return result.status === 409 && (
    text.includes("time slot no longer available") ||
    text.includes("overlaps another booking") ||
    text.includes("bookings_no_overlap")
  );
}

function candidateTime(day, index) {
  const hour = 6 + (index % 10);
  const minute = 7 + ((index * 11) % 45);
  return { day, hour, minute };
}

function manualBookingBody({ customerId, vehicleId, service, day, hour, minute = 11, customPrice }) {
  const duration = Number(service.duration_minutes);
  const start = new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
  const end = new Date(start.getTime() + duration * 60000);
  return {
    customer_id: customerId,
    vehicle_id: vehicleId,
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    service_address: TEST_SERVICE_ADDRESS,
    service_variant_id: service.service_variant_id,
    status: "pending",
    send_customer_email: false,
    admin_manual_time: true,
    customer_notes: "Smoke test admin manual reschedule",
    ...(customPrice ? { custom_price_enabled: true, custom_base_price: customPrice } : {})
  };
}

async function getAdminBookingById(bookingId) {
  const res = await adminGet("admin-bookings");
  if (!res.ok) return { ok: false, details: failureDetails(res) };
  const rows = Array.isArray(res.json) ? res.json : (res.json.bookings || res.json.rows || res.json.data || []);
  const booking = rows.find(row => row.id === bookingId);
  return booking
    ? { ok: true, booking }
    : { ok: false, details: `booking_id=${bookingId} not found in admin-bookings response` };
}

async function main() {
  requireEnv("BASE_URL", BASE_URL);
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

  console.log("Admin Reschedule Booking Smoke Test");
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
  logTest("Admin service variants include duration", true, `duration_minutes=${service.duration_minutes}`);

  const stamp = Date.now();
  const customerRes = await adminPost("admin-create-customer", {
    first_name: "Smoke",
    last_name: "Admin Reschedule",
    email: `smoke-admin-reschedule-${stamp}@example.com`,
    phone: "5185550100",
    address: TEST_SERVICE_ADDRESS
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
    model: "Reschedule",
    vehicle_size: service.vehicle_size || "midsized"
  });
  if (!vehicleRes.ok || !vehicleRes.json?.ok || !vehicleRes.json.vehicle?.id) {
    logTest("Admin create vehicle", false, failureDetails(vehicleRes));
    return finish();
  }
  const vehicleId = vehicleRes.json.vehicle.id;
  logTest("Admin create vehicle", true, `vehicle_id=${vehicleId}`);

  const customPrice = 275;
  const createDays = nextWeekdays(18, 45 + (stamp % 21)).map(yyyyMmDd);
  let createRes = null;
  let createAttempt = null;
  for (let i = 0; i < createDays.length; i++) {
    const slot = candidateTime(createDays[i], i);
    const result = await adminPost("admin-create-booking", manualBookingBody({
      customerId,
      vehicleId,
      service,
      ...slot,
      customPrice
    }));
    createRes = result;
    createAttempt = slot;
    if (result.ok && result.json?.ok && result.json.status === "pending") break;
    if (!isSlotConflict(result)) break;
  }
  if (!createRes.ok || !createRes.json?.ok || createRes.json.status !== "pending") {
    logTest("Admin create pending custom-price booking", false, failureDetails(createRes));
    return finish();
  }
  const bookingId = createRes.json.bookingId;
  const beforeLookup = await getAdminBookingById(bookingId);
  if (!beforeLookup.ok) {
    logTest("Admin booking visible before reschedule", false, beforeLookup.details);
    return finish();
  }
  const before = beforeLookup.booking;
  logTest("Admin create pending custom-price booking", true, `booking_id=${bookingId}; start=${createAttempt.day} ${createAttempt.hour}:${String(createAttempt.minute).padStart(2, "0")}`);

  const rescheduleDays = nextWeekdays(18, 90 + (stamp % 21)).map(yyyyMmDd);
  const firstRescheduleSlot = candidateTime(rescheduleDays[0], 3);
  const forbiddenRes = await adminPost("admin-reschedule-booking", {
    booking_id: bookingId,
    scheduled_start: new Date(`${firstRescheduleSlot.day}T${String(firstRescheduleSlot.hour).padStart(2, "0")}:${String(firstRescheduleSlot.minute).padStart(2, "0")}:00`).toISOString(),
    scheduled_end: new Date(`${firstRescheduleSlot.day}T10:11:00`).toISOString()
  });
  if (forbiddenRes.status !== 400 || forbiddenRes.json?.ok !== false) {
    logTest("Admin reschedule rejects client scheduled_end", false, failureDetails(forbiddenRes));
    return finish();
  }
  logTest("Admin reschedule rejects client scheduled_end", true);

  let newStart = null;
  let rescheduleRes = null;
  for (let i = 0; i < rescheduleDays.length; i++) {
    const slot = candidateTime(rescheduleDays[i], i + 4);
    newStart = new Date(`${slot.day}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}:00`);
    const result = await adminPost("admin-reschedule-booking", {
      booking_id: bookingId,
      scheduled_start: newStart.toISOString(),
      send_customer_email: false
    });
    rescheduleRes = result;
    if (result.ok && result.json?.ok) break;
    if (!isSlotConflict(result)) break;
  }
  if (!rescheduleRes.ok || !rescheduleRes.json?.ok) {
    logTest("Admin reschedule pending booking", false, failureDetails(rescheduleRes));
    return finish();
  }
  logTest("Admin reschedule pending booking", true, `scheduled_start=${rescheduleRes.json.scheduled_start}`);

  const afterLookup = await getAdminBookingById(bookingId);
  if (!afterLookup.ok) {
    logTest("Admin booking visible after reschedule", false, afterLookup.details);
    return finish();
  }
  const after = afterLookup.booking;
  const expectedEnd = new Date(newStart.getTime() + Number(service.duration_minutes) * 60000).toISOString();
  const afterStartMs = new Date(after.scheduled_start).getTime();
  const beforeStartMs = new Date(before.scheduled_start).getTime();
  const afterEndMs = new Date(after.scheduled_end).getTime();
  const expectedEndMs = new Date(expectedEnd).getTime();
  const startChanged = afterStartMs === newStart.getTime() && afterStartMs !== beforeStartMs;
  const endCalculated = afterEndMs === expectedEndMs;
  const priceUnchanged =
    String(after.base_price) === String(before.base_price) &&
    String(after.travel_fee) === String(before.travel_fee) &&
    String(after.total_price) === String(before.total_price) &&
    String(after.discount_code) === String(before.discount_code) &&
    String(after.discount_amount) === String(before.discount_amount);

  logTest("scheduled_start changed", startChanged, `before=${before.scheduled_start} after=${after.scheduled_start}`);
  logTest("scheduled_end calculated from duration", endCalculated, `expected=${expectedEnd} actual=${after.scheduled_end}`);
  logTest("price fields unchanged", priceUnchanged, `base=${after.base_price} travel=${after.travel_fee} total=${after.total_price}`);

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
