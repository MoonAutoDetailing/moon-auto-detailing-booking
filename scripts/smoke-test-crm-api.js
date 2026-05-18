#!/usr/bin/env node
/**
 * Smoke test for CRM admin APIs.
 *
 * Usage:
 *   BASE_URL=https://your-preview-or-prod-like-url ADMIN_PASSWORD=... \
 *   [VERCEL_PROTECTION_BYPASS=...] node scripts/smoke-test-crm-api.js
 */

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;

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
  const status = outcome === true ? "PASS" : "FAIL";
  console.log(`\n--- ${name} ---`);
  console.log(status);
  if (details) console.log(details);
  results.push({ name, status, details });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function apiUrl(path) {
  const normalizedPath = path.startsWith("/api/") ? path.slice(5) : path.replace(/^\//, "");
  const base = `${BASE_URL}/api/${normalizedPath}`;
  if (!BYPASS) return base;
  return normalizedPath.includes("?")
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

async function requestJson(method, path, body) {
  const endpoint = apiUrl(path);
  const res = await fetch(endpoint, {
    method,
    headers: headers(method !== "GET"),
    ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) })
  });
  appendCookie(responseCookie(res));
  const { json, text } = await readJson(res);
  return { endpoint, status: res.status, ok: res.ok, json, text };
}

async function adminLogin() {
  const result = await requestJson("POST", "/api/admin-login", { password: ADMIN_PASSWORD });
  assert(result.ok && result.json?.token, `admin-login failed: HTTP ${result.status} response=${result.text}`);
  adminSession = result.json.token;
}

function failureDetails(result) {
  return `Endpoint=${result.endpoint} HTTP ${result.status} response=${result.text}`;
}

async function runStep(name, fn) {
  try {
    const details = await fn();
    logTest(name, true, details);
  } catch (err) {
    logTest(name, false, err.message || String(err));
    finish();
  }
}

function futureIso(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

async function main() {
  requireEnv("BASE_URL", BASE_URL);
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

  console.log("CRM API Smoke Test");
  console.log("BASE_URL:", BASE_URL);

  await ensureBypassCookie();
  await adminLogin();
  logTest("Admin login", true);

  const stamp = Date.now();
  const state = {
    customerId: null,
    taskId: null,
    tagId: null
  };

  await runStep("GET /api/admin-crm-customers?limit=5", async () => {
    const res = await requestJson("GET", "/api/admin-crm-customers?limit=5");
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(Array.isArray(res.json.customers), "customers must be an array");
    return `count=${res.json.count}`;
  });

  await runStep("POST /api/admin-crm-create-lead", async () => {
    const res = await requestJson("POST", "/api/admin-crm-create-lead", {
      full_name: `CRM Smoke Test ${stamp}`,
      email: `crm-smoke-test-${stamp}@example.com`,
      phone: "5185550199",
      address: "CRM Smoke Test Address",
      company_name: "CRM Smoke Test Company",
      customer_type: "residential",
      lifecycle_stage: "lead",
      lead_source: "smoke_test",
      preferred_contact_method: "sms",
      status: "active",
      priority: "medium",
      crm_notes: "Clearly fake CRM Smoke Test lead.",
      next_follow_up_at: futureIso(60),
      follow_up_notes: "Initial CRM smoke test follow-up."
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.customer_id, "customer_id missing from response");
    state.customerId = res.json.customer_id;
    return `customer_id=${state.customerId}`;
  });

  await runStep("GET /api/admin-crm-customer-detail", async () => {
    const res = await requestJson("GET", `/api/admin-crm-customer-detail?customer_id=${encodeURIComponent(state.customerId)}`);
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.customer?.customer_id === state.customerId, "customer detail did not return created customer");
    return `vehicles=${res.json.vehicles?.length || 0} tasks=${res.json.follow_up_tasks?.length || 0}`;
  });

  await runStep("POST /api/admin-crm-update-profile", async () => {
    const res = await requestJson("POST", "/api/admin-crm-update-profile", {
      customer_id: state.customerId,
      company_name: "CRM Smoke Test Updated Company",
      customer_type: "residential",
      lifecycle_stage: "lead",
      lead_source: "smoke_test",
      preferred_contact_method: "email",
      status: "active",
      priority: "high",
      do_not_contact: false,
      crm_notes: "Updated by CRM API smoke test."
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.profile?.customer_id === state.customerId, "profile customer_id mismatch");
    return "profile updated";
  });

  await runStep("POST /api/admin-crm-log-outreach", async () => {
    const res = await requestJson("POST", "/api/admin-crm-log-outreach", {
      customer_id: state.customerId,
      contacted_at: new Date().toISOString(),
      method: "sms",
      outreach_type: "smoke_test_outreach",
      message_summary: "CRM Smoke Test outreach log.",
      response_status: "no_response",
      response_notes: "No real customer contacted.",
      next_follow_up_at: futureIso(120),
      follow_up_priority: "medium",
      follow_up_notes: "CRM smoke test outreach follow-up."
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.outreach_log?.id, "outreach_log id missing");
    return `outreach_log_id=${res.json.outreach_log.id}`;
  });

  await runStep("POST /api/admin-crm-follow-up-task action=create", async () => {
    const res = await requestJson("POST", "/api/admin-crm-follow-up-task", {
      action: "create",
      customer_id: state.customerId,
      task_type: "smoke_test_follow_up",
      due_at: futureIso(180),
      priority: "medium",
      notes: "CRM Smoke Test task."
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.task?.id, "task id missing");
    state.taskId = res.json.task.id;
    return `task_id=${state.taskId}`;
  });

  await runStep("POST /api/admin-crm-follow-up-task action=snooze", async () => {
    const res = await requestJson("POST", "/api/admin-crm-follow-up-task", {
      action: "snooze",
      task_id: state.taskId,
      snooze_until: futureIso(240)
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.task?.status === "snoozed", "task was not snoozed");
    return "task snoozed";
  });

  await runStep("POST /api/admin-crm-follow-up-task action=complete", async () => {
    const res = await requestJson("POST", "/api/admin-crm-follow-up-task", {
      action: "complete",
      task_id: state.taskId
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.task?.status === "completed", "task was not completed");
    return "task completed";
  });

  await runStep("POST /api/admin-crm-tags action=create_tag", async () => {
    const res = await requestJson("POST", "/api/admin-crm-tags", {
      action: "create_tag",
      name: `CRM Smoke Test ${stamp}`,
      description: "Clearly fake CRM smoke test tag."
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.tag?.id, "tag id missing");
    state.tagId = res.json.tag.id;
    return `tag_id=${state.tagId}`;
  });

  await runStep("POST /api/admin-crm-tags action=assign_tag", async () => {
    const res = await requestJson("POST", "/api/admin-crm-tags", {
      action: "assign_tag",
      customer_id: state.customerId,
      tag_id: state.tagId
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(res.json.assignment, "assignment missing");
    return "tag assigned";
  });

  await runStep("GET /api/admin-crm-tags?customer_id=<created id>", async () => {
    const res = await requestJson("GET", `/api/admin-crm-tags?customer_id=${encodeURIComponent(state.customerId)}`);
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    assert(Array.isArray(res.json.tags), "tags must be an array");
    assert(Array.isArray(res.json.assigned_tags), "assigned_tags must be an array");
    assert(res.json.assigned_tags.some((tag) => tag.id === state.tagId), "created tag not found in assigned_tags");
    return `assigned_tags=${res.json.assigned_tags.length}`;
  });

  await runStep("POST /api/admin-crm-tags action=remove_tag", async () => {
    const res = await requestJson("POST", "/api/admin-crm-tags", {
      action: "remove_tag",
      customer_id: state.customerId,
      tag_id: state.tagId
    });
    assert(res.ok && res.json?.ok === true, failureDetails(res));
    return "tag assignment removed";
  });

  console.log("\nCRM API smoke test passed.");
  finish();
}

function finish() {
  const failed = results.filter(r => r.status === "FAIL");
  console.log("\n=== Summary ===");
  for (const r of results) console.log(`${r.status}: ${r.name}${r.details ? " - " + r.details : ""}`);
  console.log(`\nPassed: ${results.filter(r => r.status === "PASS").length}, Failed: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
