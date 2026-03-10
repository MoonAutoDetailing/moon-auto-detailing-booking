#!/usr/bin/env node
/**
 * Phase 6 admin subscription management smoke test.
 * Tests only the new admin subscription control plane endpoints.
 *
 * Required env:
 *   PUBLIC_BASE_URL
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_PASSWORD
 *
 * Optional:
 *   VERCEL_PROTECTION_BYPASS — for preview; append ?x-vercel-protection-bypass=<value> to API URLs
 *
 * Run:
 *   PUBLIC_BASE_URL=<url> SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> ADMIN_PASSWORD=<pwd> \
 *   [VERCEL_PROTECTION_BYPASS=<token>] node scripts/phase6-admin-subscriptions-smoke-test.js
 */

const BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;
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

function qsBypass() {
  return BYPASS ? `?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}` : "";
}

function adminHeaders() {
  const h = { "Content-Type": "application/json" };
  if (adminSession) h["x-admin-session"] = adminSession;
  return h;
}

function apiUrl(path, useBypass = true) {
  return `${BASE_URL}/api/${path}${useBypass ? qsBypass() : ""}`;
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

async function adminGet(path) {
  await ensureAdminAuth();
  const url = apiUrl(path);
  const res = await fetch(url, { method: "GET", headers: adminHeaders() });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

async function adminPost(path, body) {
  await ensureAdminAuth();
  const url = apiUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body || {})
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

async function main() {
  requireEnv("PUBLIC_BASE_URL", BASE_URL);
  requireEnv("SUPABASE_URL", process.env.SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log("Phase 6 Admin Subscriptions Smoke Test");
  console.log("BASE_URL:", BASE_URL);

  // ---------- TEST 1 — Admin subscriptions list ----------
  try {
    const { status, json } = await adminGet("admin-subscriptions");
    if (status !== 200) {
      logTest("TEST 1 — Admin subscriptions list", false, `HTTP ${status} ${JSON.stringify(json)}`);
    } else if (!json || typeof json.subscriptions === "undefined") {
      logTest("TEST 1 — Admin subscriptions list", false, "Response missing subscriptions array");
    } else {
      const subs = Array.isArray(json.subscriptions) ? json.subscriptions : [];
      let shapeOk = true;
      if (subs.length > 0) {
        const row = subs[0];
        if (!row.id || typeof row.status === "undefined") shapeOk = false;
        if (row.active_cycle != null && (typeof row.active_cycle.status === "undefined" || (row.active_cycle.effective_window_end == null && row.active_cycle.window_end_date == null))) shapeOk = false;
        if (typeof row.completed_cycles_count === "undefined" || typeof row.missed_cycles_count === "undefined") shapeOk = false;
      }
      logTest("TEST 1 — Admin subscriptions list", shapeOk, `HTTP 200, ${subs.length} subscriptions, shape ok: ${shapeOk}`);
    }
  } catch (e) {
    logTest("TEST 1 — Admin subscriptions list", false, String(e.message || e));
  }

  // ---------- TEST 2 — Admin subscription detail ----------
  let detailSubId = null;
  try {
    const { json: listJson } = await adminGet("admin-subscriptions");
    const subs = listJson?.subscriptions || [];
    if (subs.length === 0) {
      const { data: anySub } = await supabase.from("subscriptions").select("id").limit(1).maybeSingle();
      detailSubId = anySub?.id;
    } else {
      detailSubId = subs[0].id;
    }
    if (!detailSubId) {
      logTest("TEST 2 — Admin subscription detail", "skip", "No subscription in DB to fetch detail");
    } else {
      const { status, json } = await adminGet(`admin-subscription-detail?id=${encodeURIComponent(detailSubId)}`);
      if (status !== 200) {
        logTest("TEST 2 — Admin subscription detail", false, `HTTP ${status} for id=${detailSubId}`);
      } else if (!json.subscription || !json.subscription.id) {
        logTest("TEST 2 — Admin subscription detail", false, "Detail missing subscription payload");
      } else {
        const hasMetrics = json.metrics != null && typeof json.metrics.lifetime_value === "number";
        const hasHistory = Array.isArray(json.history);
        const ok = hasMetrics && hasHistory;
        logTest("TEST 2 — Admin subscription detail", ok, `subscription + metrics + history: ${hasMetrics && hasHistory}`);
      }
    }
  } catch (e) {
    logTest("TEST 2 — Admin subscription detail", false, String(e.message || e));
  }

  // ---------- TEST 3 — Resume rejection for invalid states ----------
  try {
    const { data: activeSub } = await supabase.from("subscriptions").select("id").eq("status", "active").limit(1).maybeSingle();
    if (activeSub?.id) {
      const { status } = await adminPost("admin-resume-subscription", { subscription_id: activeSub.id });
      if (status !== 400) {
        logTest("TEST 3a — Resume rejects active", false, `Expected 400, got ${status}`);
      } else {
        logTest("TEST 3a — Resume rejects active", true, "400 as expected");
      }
    } else {
      logTest("TEST 3a — Resume rejects active", "skip", "No active subscription available");
    }

    const { data: cancelledSub } = await supabase.from("subscriptions").select("id").eq("status", "cancelled").limit(1).maybeSingle();
    if (cancelledSub?.id) {
      const { status, json } = await adminPost("admin-resume-subscription", { subscription_id: cancelledSub.id });
      if (status !== 400) {
        logTest("TEST 3b — Resume rejects cancelled", false, `Expected 400, got ${status}`);
      } else {
        logTest("TEST 3b — Resume rejects cancelled", true, "400 as expected");
      }
    } else {
      logTest("TEST 3b — Resume rejects cancelled", "skip", "No cancelled subscription available");
    }
  } catch (e) {
    logTest("TEST 3 — Resume rejection", false, String(e.message || e));
  }

  // ---------- TEST 4 — Pause / Resume success path ----------
  let pauseResumeSubId = null;
  try {
    const { data: pausedSub } = await supabase.from("subscriptions").select("id").eq("status", "paused").limit(1).maybeSingle();
    if (pausedSub?.id) {
      pauseResumeSubId = pausedSub.id;
      const { status, json } = await adminPost("admin-resume-subscription", { subscription_id: pauseResumeSubId });
      if (status !== 200 || !json?.ok) {
        logTest("TEST 4 — Resume success", false, `resume: ${status} ${JSON.stringify(json)}`);
      } else {
        const { data: row } = await supabase.from("subscriptions").select("status").eq("id", pauseResumeSubId).single();
        if (row?.status !== "active") {
          logTest("TEST 4 — Resume success", false, `DB status after resume: ${row?.status}`);
        } else {
          const { status: pauseStatus } = await adminPost("admin-pause-subscription", { subscription_id: pauseResumeSubId });
          if (pauseStatus !== 200) {
            logTest("TEST 4 — Pause/Resume", false, `pause back: ${pauseStatus}`);
          } else {
            const { data: row2 } = await supabase.from("subscriptions").select("status").eq("id", pauseResumeSubId).single();
            logTest("TEST 4 — Pause/Resume", row2?.status === "paused", "resume then pause; DB status restored to paused");
          }
        }
      }
    } else {
      const { data: activeSub } = await supabase.from("subscriptions").select("id").eq("status", "active").limit(1).maybeSingle();
      if (activeSub?.id) {
        pauseResumeSubId = activeSub.id;
        const { status: pauseStatus } = await adminPost("admin-pause-subscription", { subscription_id: pauseResumeSubId });
        if (pauseStatus !== 200) {
          logTest("TEST 4 — Pause/Resume", false, `pause: ${pauseStatus}`);
        } else {
          const { data: row } = await supabase.from("subscriptions").select("status").eq("id", pauseResumeSubId).single();
          if (row?.status !== "paused") {
            logTest("TEST 4 — Pause", false, `DB status after pause: ${row?.status}`);
          } else {
            const { status: resumeStatus } = await adminPost("admin-resume-subscription", { subscription_id: pauseResumeSubId });
            if (resumeStatus !== 200) {
              logTest("TEST 4 — Pause/Resume", false, `resume: ${resumeStatus}`);
            } else {
              const { data: row2 } = await supabase.from("subscriptions").select("status").eq("id", pauseResumeSubId).single();
              logTest("TEST 4 — Pause/Resume", row2?.status === "active", "pause then resume; DB status active");
            }
          }
        }
      } else {
        logTest("TEST 4 — Pause/Resume", "skip", "No paused or active subscription available");
      }
    }
  } catch (e) {
    logTest("TEST 4 — Pause/Resume", false, String(e.message || e));
  }

  // ---------- TEST 5 — Cancel behavior ----------
  let cancelSubId = null;
  try {
    const { data: candidate } = await supabase
      .from("subscriptions")
      .select("id")
      .in("status", ["active", "paused"])
      .limit(1)
      .maybeSingle();
    if (!candidate?.id) {
      logTest("TEST 5 — Cancel", "skip", "No active or paused subscription to cancel");
    } else {
      cancelSubId = candidate.id;
      const { status, json } = await adminPost("admin-cancel-subscription", { subscription_id: cancelSubId });
      if (status !== 200 || !json?.ok) {
        logTest("TEST 5 — Cancel", false, `first cancel: ${status} ${JSON.stringify(json)}`);
      } else {
        const { data: row } = await supabase.from("subscriptions").select("status").eq("id", cancelSubId).single();
        if (row?.status !== "cancelled") {
          logTest("TEST 5 — Cancel", false, `DB status after cancel: ${row?.status}`);
        } else {
          const { status: status2, json: json2 } = await adminPost("admin-cancel-subscription", { subscription_id: cancelSubId });
          const idempotentOk = status2 === 200 && (json2?.ok === true || json2?.message?.includes("already"));
          const { data: row2 } = await supabase.from("subscriptions").select("status").eq("id", cancelSubId).single();
          logTest("TEST 5 — Cancel", idempotentOk && row2?.status === "cancelled", "cancel then idempotent second cancel; DB remains cancelled");
        }
      }
    }
  } catch (e) {
    logTest("TEST 5 — Cancel", false, String(e.message || e));
  }

  // ---------- TEST 6 — Extend cycle success + rejection ----------
  let extendSubId = null;
  try {
    const { data: cycles } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id, window_end_date, pushback_used")
      .eq("status", "open")
      .eq("pushback_used", false);
    let openUnbooked = null;
    for (const c of cycles || []) {
      const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).maybeSingle();
      const { data: sub } = await supabase.from("subscriptions").select("status").eq("id", c.subscription_id).single();
      if (!link && sub?.status === "active") {
        openUnbooked = c;
        break;
      }
    }
    if (!openUnbooked?.subscription_id) {
      logTest("TEST 6 — Extend cycle", "skip", "No active subscription with open unbooked cycle and pushback_used=false");
    } else {
      extendSubId = openUnbooked.subscription_id;
      const origWindowEnd = openUnbooked.window_end_date;
      const { status, json } = await adminPost("admin-extend-subscription-cycle", { subscription_id: extendSubId });
      if (status !== 200 || !json?.ok) {
        logTest("TEST 6 — Extend cycle success", false, `${status} ${JSON.stringify(json)}`);
      } else {
        const { data: cycleAfter } = await supabase
          .from("subscription_cycles")
          .select("pushback_used, free_pushback, pushback_end_date, window_end_date")
          .eq("id", openUnbooked.id)
          .single();
        const ok = cycleAfter?.pushback_used === true && cycleAfter?.free_pushback === true &&
          cycleAfter?.pushback_end_date && cycleAfter.pushback_end_date > (origWindowEnd || "");
        if (!ok) {
          logTest("TEST 6 — Extend cycle success", false, `DB: pushback_used=${cycleAfter?.pushback_used} free_pushback=${cycleAfter?.free_pushback} pushback_end_date=${cycleAfter?.pushback_end_date}`);
        } else {
          const { status: status2 } = await adminPost("admin-extend-subscription-cycle", { subscription_id: extendSubId });
          logTest("TEST 6 — Extend cycle", status2 === 400, "extend succeeded; second extend rejected 400");
        }
      }
    }

    const { data: bookedCycle } = await supabase
      .from("subscription_cycle_bookings")
      .select("cycle_id")
      .limit(1)
      .maybeSingle();
    if (!bookedCycle?.cycle_id) {
      logTest("TEST 6b — Extend rejects booked cycle", "skip", "SKIP TEST 6b — Extend rejects booked cycle: no booked cycle candidate");
    } else {
      const { data: cy } = await supabase.from("subscription_cycles").select("subscription_id").eq("id", bookedCycle.cycle_id).single();
      if (cy?.subscription_id) {
        const { status: st } = await adminPost("admin-extend-subscription-cycle", { subscription_id: cy.subscription_id });
        if (st !== 400) {
          logTest("TEST 6b — Extend rejects booked cycle", false, `Expected 400, got ${st}`);
        } else {
          logTest("TEST 6b — Extend rejects booked cycle", true, "400 as expected");
        }
      } else {
        logTest("TEST 6b — Extend rejects booked cycle", "skip", "SKIP TEST 6b — Extend rejects booked cycle: no booked cycle candidate");
      }
    }
  } catch (e) {
    logTest("TEST 6 — Extend cycle", false, String(e.message || e));
  }

  // ---------- TEST 7 — Force-create cycle success + rejection ----------
  try {
    const { data: withUnresolved } = await supabase
      .from("subscription_cycles")
      .select("subscription_id")
      .in("status", ["open", "booked"])
      .limit(1)
      .maybeSingle();
    if (withUnresolved?.subscription_id) {
      const { status } = await adminPost("admin-force-create-subscription-cycle", { subscription_id: withUnresolved.subscription_id });
      if (status !== 400) {
        logTest("TEST 7a — Force-create rejects when cycle exists", false, `Expected 400, got ${status}`);
      } else {
        logTest("TEST 7a — Force-create rejects when cycle exists", true, "400 as expected");
      }
    } else {
      logTest("TEST 7a — Force-create rejects when cycle exists", "skip", "No subscription with open/booked cycle");
    }

    const { data: allSubs } = await supabase.from("subscriptions").select("id").eq("status", "active");
    let noCycleSubId = null;
    for (const s of allSubs || []) {
      const { data: unresolved } = await supabase
        .from("subscription_cycles")
        .select("id")
        .eq("subscription_id", s.id)
        .in("status", ["open", "booked"])
        .maybeSingle();
      if (!unresolved) {
        noCycleSubId = s.id;
        break;
      }
    }
    if (!noCycleSubId) {
      logTest("TEST 7b — Force-create success", "skip", "No active subscription without open/booked cycle");
    } else {
      const { status, json } = await adminPost("admin-force-create-subscription-cycle", { subscription_id: noCycleSubId });
      if (status !== 200 || !json?.ok) {
        logTest("TEST 7b — Force-create success", false, `${status} ${JSON.stringify(json)}`);
      } else {
        const { data: cycles } = await supabase
          .from("subscription_cycles")
          .select("id, status")
          .eq("subscription_id", noCycleSubId)
          .in("status", ["open", "booked"]);
        const oneOpen = cycles?.length === 1 && cycles[0]?.status === "open";
        logTest("TEST 7b — Force-create success", oneOpen, oneOpen ? "Exactly one new open cycle" : `cycles: ${JSON.stringify(cycles)}`);
      }
    }
  } catch (e) {
    logTest("TEST 7 — Force-create cycle", false, String(e.message || e));
  }

  // ---------- TEST 8 — Plan change validation failures ----------
  try {
    const { data: cycles } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id")
      .eq("status", "open");
    let planChangeSubId = null;
    for (const c of cycles || []) {
      const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).maybeSingle();
      if (!link) {
        planChangeSubId = c.subscription_id;
        break;
      }
    }
    if (!planChangeSubId) {
      logTest("TEST 8 — Plan change validation", "skip", "No subscription with open unbooked cycle");
    } else {
      const a = await adminPost("admin-change-subscription-plan", { subscription_id: planChangeSubId });
      const b = await adminPost("admin-change-subscription-plan", { subscription_id: planChangeSubId, frequency: "invalid" });
      const c = await adminPost("admin-change-subscription-plan", { subscription_id: planChangeSubId, service_variant_id: "00000000-0000-0000-0000-000000000000" });
      const okA = a.status === 400;
      const okB = b.status === 400;
      const okC = c.status === 400;
      logTest("TEST 8 — Plan change validation", okA && okB && okC, `no params: ${a.status}, invalid freq: ${b.status}, invalid variant: ${c.status}`);
    }
  } catch (e) {
    logTest("TEST 8 — Plan change validation", false, String(e.message || e));
  }

  // ---------- TEST 9 — Plan change success path ----------
  try {
    const { data: cycles } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id")
      .eq("status", "open");
    let planSuccessSubId = null;
    for (const c of cycles || []) {
      const { data: link } = await supabase.from("subscription_cycle_bookings").select("id").eq("cycle_id", c.id).maybeSingle();
      if (!link) {
        planSuccessSubId = c.subscription_id;
        break;
      }
    }
    if (!planSuccessSubId) {
      logTest("TEST 9 — Plan change success", "skip", "No subscription with open unbooked cycle");
    } else {
      const { data: sub } = await supabase.from("subscriptions").select("frequency").eq("id", planSuccessSubId).single();
      const currentFreq = sub?.frequency;
      const targetFreq = currentFreq === "monthly" ? "biweekly" : currentFreq === "biweekly" ? "monthly" : "biweekly";
      const { status, json } = await adminPost("admin-change-subscription-plan", { subscription_id: planSuccessSubId, frequency: targetFreq });
      if (status !== 200 || !json?.ok) {
        logTest("TEST 9 — Plan change success", false, `${status} ${JSON.stringify(json)}`);
      } else {
        const { data: row } = await supabase.from("subscriptions").select("frequency, discount_reset_required").eq("id", planSuccessSubId).single();
        const freqOk = row?.frequency === targetFreq;
        const resetOk = row?.discount_reset_required === true;
        const { count } = await supabase.from("subscription_cycles").select("id", { count: "exact", head: true }).eq("subscription_id", planSuccessSubId).in("status", ["open", "booked"]);
        const noExtraCycle = count === 1;
        logTest("TEST 9 — Plan change success", freqOk && resetOk && noExtraCycle, `frequency=${row?.frequency} discount_reset_required=${row?.discount_reset_required} open cycles=${count}`);
        if (freqOk && currentFreq) {
          await adminPost("admin-change-subscription-plan", { subscription_id: planSuccessSubId, frequency: currentFreq });
        }
      }
    }
  } catch (e) {
    logTest("TEST 9 — Plan change success", false, String(e.message || e));
  }

  // ---------- TEST 10 — Lifetime value sanity ----------
  try {
    const subId = detailSubId || (await supabase.from("subscriptions").select("id").limit(1).maybeSingle()).data?.id;
    if (!subId) {
      logTest("TEST 10 — Lifetime value sanity", "skip", "No subscription for detail");
    } else {
      const { status, json } = await adminGet(`admin-subscription-detail?id=${encodeURIComponent(subId)}`);
      if (status !== 200 || !json?.metrics) {
        logTest("TEST 10 — Lifetime value sanity", false, `detail: ${status} or missing metrics`);
      } else {
        const lv = json.metrics.lifetime_value;
        const history = json.recent_booking_history || [];
        let sanityOk = true;
        let verified = "metrics shape ok";
        for (const b of history) {
          if (b.display_total != null && b.total_price != null) {
            const pushback = (b.pushback_fee_applied && b.pushback_fee_amount) ? Number(b.pushback_fee_amount) : 0;
            const expected = Number(b.total_price) + pushback;
            const actual = Number(b.display_total);
            if (Math.abs(actual - expected) > 0.01) {
              sanityOk = false;
              verified = `display_total ${actual} != total_price + pushback ${expected}`;
              break;
            }
            verified = "display_total = total_price + pushback when applied";
          }
        }
        if (typeof lv !== "number" || lv < 0) {
          sanityOk = false;
          verified = "lifetime_value missing or negative";
        }
        logTest("TEST 10 — Lifetime value sanity", sanityOk, `lifetime_value=${lv} ${verified}`);
      }
    }
  } catch (e) {
    logTest("TEST 10 — Lifetime value sanity", false, String(e.message || e));
  }

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
