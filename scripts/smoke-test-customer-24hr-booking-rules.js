#!/usr/bin/env node
/**
 * Smoke test for customer manage-booking 24-hour cancel/reschedule blocks.
 *
 * Usage:
 *   BASE_URL=https://your-preview-or-prod-like-url TEST_MANAGE_TOKEN_WITHIN_24H=... \
 *   [VERCEL_PROTECTION_BYPASS=...] node scripts/smoke-test-customer-24hr-booking-rules.js
 *
 * If TEST_MANAGE_TOKEN_WITHIN_24H is missing, this script exits 0 with SKIP.
 * The token must belong to a booking scheduled within 24 hours. Correct behavior is
 * HTTP non-2xx or ok:false with code WITHIN_24_HOURS for both endpoints.
 */

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.TEST_MANAGE_TOKEN_WITHIN_24H;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;
const WITHIN_24_HOURS_MESSAGE = "Because your appointment is within 24 hours, online cancellations or reschedule requests are no longer available. Please call or text Darren at (518) 496-3691 to request a cancellation or reschedule.";

let bypassCookie = null;
const results = [];

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
  return `${base}?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
}

function headers() {
  return {
    "Content-Type": "application/json",
    ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
    ...(bypassCookie ? { cookie: bypassCookie } : {})
  };
}

async function ensureBypassCookie() {
  if (!BYPASS) return;
  const url = `${BASE_URL}/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
  const res = await fetch(url);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  bypassCookie = setCookies.length ? setCookies.join("; ") : (res.headers.get("set-cookie") || null);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: { _raw: text } };
  }
}

async function postEndpoint(path) {
  const url = apiUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ token: TOKEN, manage_token: TOKEN })
  });
  const { json, text } = await readJson(res);
  return { endpoint: url, status: res.status, ok: res.ok, json, text };
}

function assertBlocked(name, result) {
  const code = result.json?.code;
  const appOk = result.json?.ok;
  const blocked = code === "WITHIN_24_HOURS" && result.json?.message === WITHIN_24_HOURS_MESSAGE && (!result.ok || appOk === false);
  if (blocked) {
    logTest(name, true, `HTTP ${result.status} code=${code}`);
    return;
  }

  logTest(
    name,
    false,
    `Expected WITHIN_24_HOURS block with exact message. Endpoint=${result.endpoint} HTTP ${result.status} response=${result.text}`
  );
}

async function main() {
  if (!BASE_URL) {
    console.error("Missing required env: BASE_URL");
    process.exit(1);
  }

  console.log("Customer 24-Hour Booking Rules Smoke Test");
  console.log("BASE_URL:", BASE_URL);

  if (!TOKEN) {
    logTest(
      "Token provided",
      "skip",
      "Set TEST_MANAGE_TOKEN_WITHIN_24H to a manage token for a booking scheduled within 24 hours."
    );
    return finish();
  }

  await ensureBypassCookie();

  const reschedule = await postEndpoint("customer-reschedule-booking");
  assertBlocked("Customer reschedule within 24 hours", reschedule);

  const cancel = await postEndpoint("customer-cancel-booking");
  assertBlocked("Customer cancel within 24 hours", cancel);

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
