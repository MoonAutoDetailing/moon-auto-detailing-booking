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
 *   - unsafe admin override fields are rejected
 *   - invalid custom price is rejected
 *   - unsafe direct price fields are rejected
 *   - admin pending booking creation with send_customer_email=false
 *   - manual admin-time pending booking creation
 *   - admin custom-price pending booking creation
 *   - admin confirmed booking creation with send_customer_email=false when a second slot is available
 *   - admin custom-price confirmed booking creation
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

async function getAdminBookingById(bookingId) {
  const res = await adminGet("admin-bookings");
  if (!res.ok) return { ok: false, details: failureDetails(res) };
  const rows = Array.isArray(res.json)
    ? res.json
    : (res.json.bookings || res.json.rows || res.json.data || []);
  const booking = rows.find(row => row.id === bookingId);
  return booking
    ? { ok: true, booking }
    : { ok: false, details: `booking_id=${bookingId} not found in admin-bookings response` };
}

async function assertStoredCustomPrice(bookingId, expectedBasePrice, requireCalendarEvent) {
  const lookup = await getAdminBookingById(bookingId);
  if (!lookup.ok) return lookup;
  const b = lookup.booking;
  const basePrice = Number(b.base_price);
  const travelFee = Number(b.travel_fee || 0);
  const totalPrice = Number(b.total_price);
  const expectedTotal = Math.round((expectedBasePrice + travelFee) * 100) / 100;
  if (Math.round(basePrice * 100) / 100 !== expectedBasePrice) {
    return { ok: false, details: `base_price=${b.base_price}, expected=${expectedBasePrice}` };
  }
  if (Math.round(totalPrice * 100) / 100 !== expectedTotal) {
    return { ok: false, details: `total_price=${b.total_price}, expected=${expectedTotal}, travel_fee=${travelFee}` };
  }
  if (requireCalendarEvent && !b.google_event_id) {
    return { ok: false, details: "confirmed custom-price booking did not return google_event_id in admin-bookings" };
  }
  return { ok: true, details: `base_price=${basePrice.toFixed(2)} travel_fee=${travelFee.toFixed(2)} total_price=${totalPrice.toFixed(2)}` };
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

function manualBookingBody({ customerId, vehicleId, service, day, hour, status }) {
  const duration = Number(service.duration_minutes);
  const start = new Date(`${day}T${String(hour).padStart(2, "0")}:17:00`);
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
    admin_manual_time: true,
    customer_notes: "Smoke test manual admin-time booking"
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
    first_name: "Smoke",
    last_name: "Admin Booking",
    email: `smoke-admin-booking-${stamp}@example.com`,
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

  const unsafeBody = {
    ...bookingBody({
      customerId,
      vehicleId,
      service,
      slot: availability.slots[0],
      availability,
      status: "pending"
    }),
    allowAvailabilityOverride: true
  };
  const unsafeRes = await adminPost("admin-create-booking", unsafeBody);
  if (unsafeRes.status !== 400 || unsafeRes.json?.ok !== false) {
    logTest("Admin rejects unsafe override fields", false, failureDetails(unsafeRes));
    return finish();
  }
  logTest("Admin rejects unsafe override fields", true);

  const unsafePriceBody = {
    ...bookingBody({
      customerId,
      vehicleId,
      service,
      slot: availability.slots[0],
      availability,
      status: "pending"
    }),
    base_price: 1,
    total_price: 1
  };
  const unsafePriceRes = await adminPost("admin-create-booking", unsafePriceBody);
  if (unsafePriceRes.status !== 400 || unsafePriceRes.json?.ok !== false) {
    logTest("Admin rejects direct price fields", false, failureDetails(unsafePriceRes));
    return finish();
  }
  logTest("Admin rejects direct price fields", true);

  const invalidCustomPriceBody = {
    ...bookingBody({
      customerId,
      vehicleId,
      service,
      slot: availability.slots[0],
      availability,
      status: "pending"
    }),
    custom_price_enabled: true,
    custom_base_price: 0
  };
  const invalidCustomPriceRes = await adminPost("admin-create-booking", invalidCustomPriceBody);
  if (invalidCustomPriceRes.status !== 400 || invalidCustomPriceRes.json?.ok !== false) {
    logTest("Admin rejects invalid custom price", false, failureDetails(invalidCustomPriceRes));
    return finish();
  }
  logTest("Admin rejects invalid custom price", true);

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

  const manualDays = nextWeekdays(20).slice(-4).map(yyyyMmDd);
  const manualPendingBody = manualBookingBody({
    customerId,
    vehicleId,
    service,
    day: manualDays[0],
    hour: 7,
    status: "pending"
  });
  const manualPendingRes = await adminPost("admin-create-booking", manualPendingBody);
  if (!manualPendingRes.ok || !manualPendingRes.json?.ok || manualPendingRes.json.status !== "pending") {
    logTest("Admin create manual pending booking", false, failureDetails(manualPendingRes));
    return finish();
  }
  logTest("Admin create manual pending booking", true, `bookingId=${manualPendingRes.json.bookingId}`);

  const customPendingPrice = 250;
  const customPendingBody = {
    ...manualBookingBody({
      customerId,
      vehicleId,
      service,
      day: manualDays[1],
      hour: 7,
      status: "pending"
    }),
    custom_price_enabled: true,
    custom_base_price: customPendingPrice,
    customer_notes: "Smoke test custom-price pending booking"
  };
  const customPendingRes = await adminPost("admin-create-booking", customPendingBody);
  if (!customPendingRes.ok || !customPendingRes.json?.ok || customPendingRes.json.status !== "pending") {
    logTest("Admin create custom-price pending booking", false, failureDetails(customPendingRes));
    return finish();
  }
  const customPendingCheck = await assertStoredCustomPrice(customPendingRes.json.bookingId, customPendingPrice, false);
  if (!customPendingCheck.ok) {
    logTest("Custom-price pending stored totals", false, customPendingCheck.details);
    return finish();
  }
  logTest("Admin create custom-price pending booking", true, `bookingId=${customPendingRes.json.bookingId}; ${customPendingCheck.details}`);

  const confirmedAvailability = await loadAvailability(service, 1);
  const confirmedSlot = confirmedAvailability?.slots?.find(s => s !== availability.slots[0]);
  if (!confirmedSlot) {
    logTest("Admin create confirmed booking", "skip", "No second available slot found after pending booking was created");
  } else {
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
  }

  const manualConfirmedBody = manualBookingBody({
    customerId,
    vehicleId,
    service,
    day: manualDays[2],
    hour: 19,
    status: "confirmed"
  });
  const manualConfirmedRes = await adminPost("admin-create-booking", manualConfirmedBody);
  if (!manualConfirmedRes.ok || !manualConfirmedRes.json?.ok || manualConfirmedRes.json.status !== "confirmed") {
    logTest("Admin create manual confirmed booking", false, failureDetails(manualConfirmedRes));
    return finish();
  }
  logTest("Admin create manual confirmed booking", true, `bookingId=${manualConfirmedRes.json.bookingId}`);

  const customConfirmedPrice = 325;
  const customConfirmedBody = {
    ...manualBookingBody({
      customerId,
      vehicleId,
      service,
      day: manualDays[3],
      hour: 19,
      status: "confirmed"
    }),
    custom_price_enabled: true,
    custom_base_price: customConfirmedPrice,
    customer_notes: "Smoke test custom-price confirmed booking"
  };
  const customConfirmedRes = await adminPost("admin-create-booking", customConfirmedBody);
  if (!customConfirmedRes.ok || !customConfirmedRes.json?.ok || customConfirmedRes.json.status !== "confirmed") {
    logTest("Admin create custom-price confirmed booking", false, failureDetails(customConfirmedRes));
    return finish();
  }
  const customConfirmedCheck = await assertStoredCustomPrice(customConfirmedRes.json.bookingId, customConfirmedPrice, true);
  if (!customConfirmedCheck.ok) {
    logTest("Custom-price confirmed stored totals and calendar", false, customConfirmedCheck.details);
    return finish();
  }
  logTest("Admin create custom-price confirmed booking", true, `bookingId=${customConfirmedRes.json.bookingId}; ${customConfirmedCheck.details}`);

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
