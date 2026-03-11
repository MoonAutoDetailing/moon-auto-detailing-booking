#!/usr/bin/env node
/**
 * Subscription email smoke test.
 * Verifies new subscription email flows (created, pushback, cycle-open, missed-cycle, reminders)
 * without breaking subscription behavior.
 *
 * Required env:
 *   PUBLIC_BASE_URL
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_PASSWORD
 *
 * Optional:
 *   VERCEL_PROTECTION_BYPASS — preview protection bypass
 *   CRON_SECRET — for cron endpoints (required for tests 3, 4, 5, 6, 7, 8)
 *   RESEND_API_KEY — if missing, script still runs but email send verification is best-effort
 *
 * Run:
 *   PUBLIC_BASE_URL=<url> SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> ADMIN_PASSWORD=<pwd> \
 *   [CRON_SECRET=<secret>] [VERCEL_PROTECTION_BYPASS=<token>] node scripts/subscription-email-smoke-test.js
 */

const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;
const CRON_SECRET = process.env.CRON_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

let supabase;
let adminSession = null;

const results = [];

function logTest(name, outcome, details = "") {
  const status = outcome === true ? "PASS" : outcome === false ? "FAIL" : "SKIP";
  console.log(`\n--- ${name} ---`);
  console.log(status);
  if (details) console.log(details);
  results.push({ name, status, details });
}

function apiUrl(path, useBypass = true) {
  const base = `${BASE_URL}/api/${path}`;
  if (!useBypass || !BYPASS) return base;
  return path.includes("?")
    ? `${base}&x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`
    : `${base}?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}`;
}

function cronHeaders() {
  const h = { "Content-Type": "application/json" };
  if (CRON_SECRET) h["Authorization"] = `Bearer ${CRON_SECRET}`;
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  return h;
}

function adminHeaders() {
  const h = { "Content-Type": "application/json" };
  if (adminSession) h["x-admin-session"] = adminSession;
  return h;
}

async function ensureAdminAuth() {
  if (adminSession) return true;
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
  const res = await fetch(apiUrl("admin-login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    console.error("admin-login failed:", res.status, data);
    process.exit(1);
  }
  adminSession = data.token;
  return true;
}

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addCalendarDays(dateStr, n) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${month}-${day}`;
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

async function main() {
  requireEnv("PUBLIC_BASE_URL", BASE_URL);
  requireEnv("SUPABASE_URL", process.env.SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const hasResend = !!process.env.RESEND_API_KEY;
  const hasCron = !!CRON_SECRET;
  console.log("Subscription Email Smoke Test");
  console.log("BASE_URL:", BASE_URL);
  if (!hasResend) {
    console.log("Note: RESEND_API_KEY not set. Email delivery not verified; API success and DB state are verified.");
  }
  if (!hasCron) {
    console.log("Note: CRON_SECRET not set. Cron tests (3–8) will be skipped or fail with 401.");
  }

  let subscription_id = null;
  let activation_booking_id = null;
  let manage_token = null;
  let customer_id = null;
  let vehicle_id = null;
  let service_variant_id = null;
  let reminder_cycle_id_for_resend_test = null;
  let reminder_1_sent_at_before_rerun = null;

  // ---------- TEST 1 — Subscription created flow still succeeds ----------
  try {
    let seedJson = {};
    const seedRes = await fetch(apiUrl("dev-create-test-booking"), { method: "POST" });
    if (seedRes.status === 404) {
      const { data: existing } = await supabase
        .from("subscriptions")
        .select("id, activation_booking_id")
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        subscription_id = existing.id;
        activation_booking_id = existing.activation_booking_id;
        const { data: b } = await supabase.from("bookings").select("manage_token").eq("id", activation_booking_id).single();
        manage_token = b?.manage_token ?? null;
        logTest("TEST 1 — Subscription created flow still succeeds", "skip", "dev-create-test-booking not available; using existing subscription for later tests.");
      } else {
        logTest("TEST 1 — Subscription created flow still succeeds", "skip", "dev-create-test-booking not available (404) and no existing subscription.");
      }
    } else {
      const seedText = await seedRes.text();
      try { seedJson = JSON.parse(seedText); } catch { seedJson = {}; }
      if (seedRes.status >= 500 || !seedJson.customer_id) {
        logTest("TEST 1 — Subscription created flow still succeeds", false, `Seed failed: ${seedRes.status} ${seedText}`);
      } else {
        customer_id = seedJson.customer_id;
        vehicle_id = seedJson.vehicle_id;
        service_variant_id = seedJson.service_variant_id;
        const { start, end } = getTestSlot();
        const createBookingRes = await fetch(apiUrl("create-booking"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id,
            vehicle_id,
            service_variant_id,
            service_address: "11 Grant St, Cohoes, NY 12047",
            scheduled_start: start.toISOString(),
            scheduled_end: end.toISOString()
          })
        });
        const createBookingJson = await createBookingRes.json().catch(() => ({}));
        if (!createBookingRes.ok || !createBookingJson.bookingId) {
          logTest("TEST 1 — Subscription created flow still succeeds", false, `create-booking: ${createBookingRes.status} ${JSON.stringify(createBookingJson)}`);
        } else {
          activation_booking_id = createBookingJson.bookingId;
          const subBody = {
            customer_id,
            vehicle_id,
            service_variant_id,
            default_address: "11 Grant St, Cohoes, NY 12047",
            frequency: "monthly",
            activation_booking_id
          };
          const subRes = await fetch(apiUrl("create-subscription"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subBody)
          });
          const subJson = await subRes.json().catch(() => ({}));
          if (subRes.status !== 200 || !subJson.ok || !subJson.subscription_id) {
            logTest("TEST 1 — Subscription created flow still succeeds", false, `create-subscription: ${subRes.status} ${JSON.stringify(subJson)}`);
          } else {
            subscription_id = subJson.subscription_id;
            logTest("TEST 1 — Subscription created flow still succeeds", true, `API 200, subscription_id=${subscription_id}. Email attempted server-side (check logs if RESEND configured).`);
          }
        }
      }
    }
  } catch (e) {
    logTest("TEST 1 — Subscription created flow still succeeds", false, String(e.message || e));
  }

  if (!manage_token && activation_booking_id) {
    const { data: b } = await supabase.from("bookings").select("manage_token").eq("id", activation_booking_id).single();
    manage_token = b?.manage_token ?? null;
  }

  // ---------- TEST 2 — Pushback flow still succeeds ----------
  try {
    if (!subscription_id) {
      logTest("TEST 2 — Pushback flow still succeeds", "skip", "No subscription_id from TEST 1.");
    } else if (!manage_token) {
      logTest("TEST 2 — Pushback flow still succeeds", "skip", "No activation booking manage_token.");
    } else {
      const { data: openCycle } = await supabase
        .from("subscription_cycles")
        .select("id, window_end_date, pushback_used")
        .eq("subscription_id", subscription_id)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();

      const { data: linked } = openCycle
        ? await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", openCycle.id).limit(1).maybeSingle()
        : { data: null };

      if (!openCycle?.id || openCycle.pushback_used || linked) {
        logTest("TEST 2 — Pushback flow still succeeds", "skip", "No open cycle eligible for pushback (or already has booking/pushback).");
      } else {
        const pushRes = await fetch(apiUrl("customer-subscription-pushback"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: manage_token })
        });
        const pushJson = await pushRes.json().catch(() => ({}));
        if (pushRes.status !== 200 || !pushJson.ok) {
          logTest("TEST 2 — Pushback flow still succeeds", false, `customer-subscription-pushback: ${pushRes.status} ${JSON.stringify(pushJson)}`);
        } else {
          const { data: after } = await supabase
            .from("subscription_cycles")
            .select("pushback_used, pushback_end_date")
            .eq("id", openCycle.id)
            .single();
          const ok = after?.pushback_used === true && after?.pushback_end_date;
          logTest("TEST 2 — Pushback flow still succeeds", ok, ok ? `pushback_used=true, pushback_end_date=${after.pushback_end_date}` : `DB state: ${JSON.stringify(after)}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 2 — Pushback flow still succeeds", false, String(e.message || e));
  }

  // ---------- TEST 3 — Cycle-open email path still works ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 3 — Cycle-open email path still works", "skip", "CRON_SECRET not set.");
    } else {
      const { data: activeSubs } = await supabase
        .from("subscriptions")
        .select("id")
        .eq("status", "active")
        .limit(5);
      let subWithNoOpen = null;
      if (activeSubs?.length) {
        for (const s of activeSubs) {
          const { data: unresolved } = await supabase
            .from("subscription_cycles")
            .select("id")
            .eq("subscription_id", s.id)
            .in("status", ["open", "booked"])
            .limit(1)
            .maybeSingle();
          if (!unresolved) {
            subWithNoOpen = s.id;
            break;
          }
        }
      }
      if (!subWithNoOpen) {
        logTest("TEST 3 — Cycle-open email path still works", "skip", "No active subscription without an open/booked cycle.");
      } else {
        const cronRes = await fetch(apiUrl("cron-generate-subscription-cycles"), {
          method: "POST",
          headers: cronHeaders()
        });
        const cronJson = await cronRes.json().catch(() => ({}));
        if (cronRes.status === 401) {
          logTest("TEST 3 — Cycle-open email path still works", false, "Cron returned 401 (check CRON_SECRET).");
        } else if (!cronRes.ok) {
          logTest("TEST 3 — Cycle-open email path still works", false, `cron-generate: ${cronRes.status} ${JSON.stringify(cronJson)}`);
        } else {
          const { data: newOpen } = await supabase
            .from("subscription_cycles")
            .select("id")
            .eq("subscription_id", subWithNoOpen)
            .eq("status", "open");
          const created = Array.isArray(newOpen) && newOpen.length >= 1;
          logTest("TEST 3 — Cycle-open email path still works", created, created ? "Cron 200, new open cycle created." : `Cron 200 but open cycles: ${newOpen?.length ?? 0}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 3 — Cycle-open email path still works", false, String(e.message || e));
  }

  // ---------- TEST 4 — Missed-cycle email path still works ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 4 — Missed-cycle email path still works", "skip", "CRON_SECRET not set.");
    } else {
      const today = todayLocal();
      const { data: openCycles } = await supabase
        .from("subscription_cycles")
        .select("id, subscription_id, window_end_date, pushback_used, pushback_end_date")
        .eq("status", "open");
      let cycleToMiss = null;
      if (openCycles?.length) {
        for (const c of openCycles) {
          const effectiveEnd = c.pushback_used && c.pushback_end_date ? c.pushback_end_date : c.window_end_date;
          if (effectiveEnd && today > effectiveEnd) {
            cycleToMiss = c;
            break;
          }
        }
      }
      if (!cycleToMiss) {
        const { data: anyOpen } = await supabase
          .from("subscription_cycles")
          .select("id, subscription_id")
          .eq("status", "open")
          .limit(1)
          .maybeSingle();
        if (anyOpen) {
          const yesterday = addCalendarDays(today, -1);
          const { error: patchErr } = await supabase
            .from("subscription_cycles")
            .update({ window_end_date: yesterday, pushback_used: false, pushback_end_date: null })
            .eq("id", anyOpen.id);
          if (!patchErr) {
            cycleToMiss = { id: anyOpen.id, subscription_id: anyOpen.subscription_id };
          }
        }
      }
      if (!cycleToMiss) {
        logTest("TEST 4 — Missed-cycle email path still works", "skip", "No open cycle past effective end (and could not safely patch one).");
      } else {
        const missRes = await fetch(apiUrl("cron-check-missed-cycles"), {
          method: "POST",
          headers: cronHeaders()
        });
        const missJson = await missRes.json().catch(() => ({}));
        if (missRes.status === 401) {
          logTest("TEST 4 — Missed-cycle email path still works", false, "Cron 401.");
        } else if (!missRes.ok) {
          logTest("TEST 4 — Missed-cycle email path still works", false, `cron-check-missed: ${missRes.status} ${JSON.stringify(missJson)}`);
        } else {
          const { data: c } = await supabase.from("subscription_cycles").select("status").eq("id", cycleToMiss.id).single();
          const { data: sub } = await supabase.from("subscriptions").select("discount_reset_required").eq("id", cycleToMiss.subscription_id).single();
          const ok = c?.status === "missed" && (sub?.discount_reset_required === true || sub?.discount_reset_required === false);
          logTest("TEST 4 — Missed-cycle email path still works", ok, ok ? `cycle=missed, discount_reset_required=${sub?.discount_reset_required}` : `cycle=${c?.status}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 4 — Missed-cycle email path still works", false, String(e.message || e));
  }

  // ---------- TEST 5 — Reminder cron sends reminder 1 ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 5 — Reminder cron sends reminder 1", "skip", "CRON_SECRET not set.");
    } else {
      const today = todayLocal();
      const targetEnd = addCalendarDays(today, 3);
      const { data: openCycles } = await supabase
        .from("subscription_cycles")
        .select("id, reminder_1_sent_at, reminder_2_sent_at, window_end_date, pushback_used, pushback_end_date")
        .eq("status", "open");
      let candidate = null;
      if (openCycles?.length) {
        for (const c of openCycles) {
          const effectiveEnd = c.pushback_used && c.pushback_end_date ? c.pushback_end_date : c.window_end_date;
          if (effectiveEnd === targetEnd && !c.reminder_1_sent_at) {
            const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).limit(1).maybeSingle();
            if (!link) {
              candidate = c;
              break;
            }
          }
        }
      }
      if (!candidate) {
        const { data: anyOpen } = await supabase
          .from("subscription_cycles")
          .select("id, reminder_1_sent_at, reminder_2_sent_at")
          .eq("status", "open")
          .limit(5);
        for (const c of anyOpen || []) {
          const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).limit(1).maybeSingle();
          if (!link && !c.reminder_1_sent_at) {
            const { error: patchErr } = await supabase
              .from("subscription_cycles")
              .update({ window_end_date: targetEnd, pushback_used: false, pushback_end_date: null })
              .eq("id", c.id);
            if (!patchErr) {
              candidate = { id: c.id };
              break;
            }
          }
        }
      }
      if (!candidate) {
        logTest("TEST 5 — Reminder cron sends reminder 1", "skip", "No open cycle with effective_end=today+3 and no booking (patch attempted).");
      } else {
        const remRes = await fetch(apiUrl("cron-send-subscription-reminders"), {
          method: "POST",
          headers: cronHeaders()
        });
        const remJson = await remRes.json().catch(() => ({}));
        if (remRes.status === 401) {
          logTest("TEST 5 — Reminder cron sends reminder 1", false, "Cron 401.");
        } else if (!remRes.ok) {
          logTest("TEST 5 — Reminder cron sends reminder 1", false, `cron-send-reminders: ${remRes.status} ${JSON.stringify(remJson)}`);
        } else {
          const { data: after } = await supabase
            .from("subscription_cycles")
            .select("reminder_1_sent_at, reminder_2_sent_at")
            .eq("id", candidate.id)
            .single();
          const r1Set = !!after?.reminder_1_sent_at;
          const r2NotSet = !after?.reminder_2_sent_at;
          reminder_cycle_id_for_resend_test = candidate.id;
          reminder_1_sent_at_before_rerun = after?.reminder_1_sent_at ?? null;
          logTest("TEST 5 — Reminder cron sends reminder 1", r1Set && r2NotSet, r1Set && r2NotSet ? `reminder_1_sent_at set, reminder_2 unchanged` : `reminder_1_sent_at=${!!r1Set}, reminder_2_sent_at=${!!after?.reminder_2_sent_at}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 5 — Reminder cron sends reminder 1", false, String(e.message || e));
  }

  // ---------- TEST 6 — Reminder cron sends reminder 2 ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 6 — Reminder cron sends reminder 2", "skip", "CRON_SECRET not set.");
    } else {
      const today = todayLocal();
      const targetEnd = addCalendarDays(today, 1);
      const { data: openCycles } = await supabase
        .from("subscription_cycles")
        .select("id, reminder_2_sent_at, window_end_date, pushback_used, pushback_end_date")
        .eq("status", "open");
      let candidate = null;
      if (openCycles?.length) {
        for (const c of openCycles) {
          const effectiveEnd = c.pushback_used && c.pushback_end_date ? c.pushback_end_date : c.window_end_date;
          if (effectiveEnd === targetEnd && !c.reminder_2_sent_at) {
            const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).limit(1).maybeSingle();
            if (!link) {
              candidate = c;
              break;
            }
          }
        }
      }
      if (!candidate) {
        const { data: anyOpen } = await supabase
          .from("subscription_cycles")
          .select("id, reminder_2_sent_at")
          .eq("status", "open")
          .limit(5);
        for (const c of anyOpen || []) {
          const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).limit(1).maybeSingle();
          if (!link && !c.reminder_2_sent_at) {
            const { error: patchErr } = await supabase
              .from("subscription_cycles")
              .update({ window_end_date: targetEnd, pushback_used: false, pushback_end_date: null })
              .eq("id", c.id);
            if (!patchErr) {
              candidate = { id: c.id };
              break;
            }
          }
        }
      }
      if (!candidate) {
        logTest("TEST 6 — Reminder cron sends reminder 2", "skip", "No open cycle with effective_end=today+1 and no booking.");
      } else {
        const remRes = await fetch(apiUrl("cron-send-subscription-reminders"), {
          method: "POST",
          headers: cronHeaders()
        });
        const remJson = await remRes.json().catch(() => ({}));
        if (remRes.status === 401) {
          logTest("TEST 6 — Reminder cron sends reminder 2", false, "Cron 401.");
        } else if (!remRes.ok) {
          logTest("TEST 6 — Reminder cron sends reminder 2", false, `cron-send-reminders: ${remRes.status} ${JSON.stringify(remJson)}`);
        } else {
          const { data: after } = await supabase
            .from("subscription_cycles")
            .select("reminder_2_sent_at")
            .eq("id", candidate.id)
            .single();
          const ok = !!after?.reminder_2_sent_at;
          logTest("TEST 6 — Reminder cron sends reminder 2", ok, ok ? "reminder_2_sent_at set." : "reminder_2_sent_at not set.");
        }
      }
    }
  } catch (e) {
    logTest("TEST 6 — Reminder cron sends reminder 2", false, String(e.message || e));
  }

  // ---------- TEST 7 — Reminder cron skips booked cycles ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 7 — Reminder cron skips booked cycles", "skip", "CRON_SECRET not set.");
    } else {
      const { data: linked } = await supabase
        .from("subscription_cycle_bookings")
        .select("cycle_id")
        .limit(1)
        .maybeSingle();
      if (!linked?.cycle_id) {
        logTest("TEST 7 — Reminder cron skips booked cycles", "skip", "No cycle with linked booking in DB.");
      } else {
        const { data: before } = await supabase
          .from("subscription_cycles")
          .select("reminder_1_sent_at, reminder_2_sent_at")
          .eq("id", linked.cycle_id)
          .single();
        const remRes = await fetch(apiUrl("cron-send-subscription-reminders"), {
          method: "POST",
          headers: cronHeaders()
        });
        const remText = await remRes.text();
        let remJson;
        try {
          remJson = remText ? JSON.parse(remText) : {};
        } catch {
          remJson = { _raw: remText?.slice(0, 200) ?? "" };
        }
        if (!remRes.ok) {
          logTest("TEST 7 — Reminder cron skips booked cycles", false, `cron-send-reminders: ${remRes.status} ${(remText?.slice(0, 100) ?? "").replace(/\s+/g, " ")}`);
        } else {
          const { data: after } = await supabase
          .from("subscription_cycles")
          .select("reminder_1_sent_at, reminder_2_sent_at")
          .eq("id", linked.cycle_id)
          .single();
        const unchanged = (before?.reminder_1_sent_at === after?.reminder_1_sent_at) && (before?.reminder_2_sent_at === after?.reminder_2_sent_at);
        logTest("TEST 7 — Reminder cron skips booked cycles", unchanged, unchanged ? "No reminder timestamps written for booked cycle." : "Timestamps changed (unexpected).");
        }
      }
    }
  } catch (e) {
    logTest("TEST 7 — Reminder cron skips booked cycles", false, String(e.message || e));
  }

  // ---------- TEST 8 — Reminder cron does not resend ----------
  try {
    if (!CRON_SECRET) {
      logTest("TEST 8 — Reminder cron does not resend", "skip", "CRON_SECRET not set.");
    } else if (!reminder_cycle_id_for_resend_test || reminder_1_sent_at_before_rerun == null) {
      logTest("TEST 8 — Reminder cron does not resend", "skip", "No cycle with reminder_1_sent_at set from TEST 5.");
    } else {
      const remRes = await fetch(apiUrl("cron-send-subscription-reminders"), {
        method: "POST",
        headers: cronHeaders()
      });
      const remText = await remRes.text();
      let remJson;
      try {
        remJson = remText ? JSON.parse(remText) : {};
      } catch {
        remJson = { _raw: remText?.slice(0, 200) ?? "" };
      }
      if (!remRes.ok) {
        logTest("TEST 8 — Reminder cron does not resend", false, `cron-send-reminders: ${remRes.status} ${(remText?.slice(0, 100) ?? "").replace(/\s+/g, " ")}`);
      } else {
        const { data: after } = await supabase
        .from("subscription_cycles")
        .select("reminder_1_sent_at")
        .eq("id", reminder_cycle_id_for_resend_test)
        .single();
      const unchanged = after?.reminder_1_sent_at === reminder_1_sent_at_before_rerun;
      logTest("TEST 8 — Reminder cron does not resend", unchanged, unchanged ? "reminder_1_sent_at unchanged after second cron run." : "reminder_1_sent_at was overwritten.");
      }
    }
  } catch (e) {
    logTest("TEST 8 — Reminder cron does not resend", false, String(e.message || e));
  }

  // ---------- Manage link / content note ----------
  results.push({ name: "Manage link / email content", status: "SKIP", details: "Runtime smoke verifies business actions only. Verify manually in staging that subscription emails include /manage-subscription.html?token= (activation booking manage_token)." });
  console.log("\n--- Manage link / email content ---");
  console.log("SKIP");
  console.log("Runtime smoke verifies business actions only. Verify manually in staging that subscription emails include /manage-subscription.html?token= (activation booking manage_token).");

  // ---------- Summary ----------
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log("\n========== SUMMARY ==========");
  console.log(`Total: ${results.length}  PASS: ${passed}  FAIL: ${failed}  SKIP: ${skipped}`);
  results.forEach((r) => console.log(`  ${r.status}  ${r.name}`));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
