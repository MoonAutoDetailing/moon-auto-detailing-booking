#!/usr/bin/env node
/**
 * Subscription lifecycle smoke test runner.
 * Runs sequential tests against the deployed API.
 *
 * Required env:
 *   PUBLIC_BASE_URL
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRON_SECRET
 *
 * Optional (for admin-complete-booking against preview):
 *   VERCEL_PROTECTION_BYPASS
 *
 * Run:
 *   PUBLIC_BASE_URL=<url> SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> CRON_SECRET=<secret> \
 *   [VERCEL_PROTECTION_BYPASS=<token>] node scripts/subscription-smoke-test.js
 */

const BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || "";
const CRON_SECRET = process.env.CRON_SECRET;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

let supabase;

const results = [];

function logTest(name, pass, details = "") {
  const status = pass ? "PASS" : "FAIL";
  console.log(`\n--- ${name} ---`);
  console.log(status);
  if (details) console.log(details);
  results.push({ name, pass, details });
}

function qsBypass() {
  return BYPASS ? `?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}` : "";
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

function yesterdayLocal() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  requireEnv("PUBLIC_BASE_URL", BASE_URL);
  requireEnv("SUPABASE_URL", process.env.SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("CRON_SECRET", CRON_SECRET);

  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!BYPASS) {
    console.warn("VERCEL_PROTECTION_BYPASS not set; admin-complete-booking calls may return 401.");
  }

  let customer_id, vehicle_id, service_variant_id;
  let subscription_id, activation_booking_id, last_booking_id;
  let open_cycle_id;

  // ---------- TEST 1 — Activation ----------
  try {
    const seedRes = await fetch(`${BASE_URL}/api/dev-create-test-booking${qsBypass()}`, { method: "POST" });
    const seedText = await seedRes.text();
    let seedJson;
    try { seedJson = JSON.parse(seedText); } catch { seedJson = {}; }
    if (seedRes.status === 404) {
      logTest("TEST 1 — Activation", false, "dev-create-test-booking not available (404). Use preview deployment or seed data.");
    } else if (seedRes.status >= 500 || !seedJson.customer_id) {
      logTest("TEST 1 — Activation", false, `Seed failed: ${seedRes.status} ${seedText}`);
    } else {
      customer_id = seedJson.customer_id;
      vehicle_id = seedJson.vehicle_id;
      service_variant_id = seedJson.service_variant_id;

      const { start, end } = getTestSlot();
      const createBody = {
        customer_id,
        vehicle_id,
        service_variant_id,
        service_address: "11 Grant St, Cohoes, NY 12047",
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString()
      };
      const createRes = await fetch(`${BASE_URL}/api/create-booking${qsBypass()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody)
      });
      const createJson = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createJson.bookingId) {
        logTest("TEST 1 — Activation", false, `create-booking: ${createRes.status} ${JSON.stringify(createJson)}`);
      } else {
        activation_booking_id = createJson.bookingId;
        const subBody = {
          customer_id,
          vehicle_id,
          service_variant_id,
          default_address: "11 Grant St, Cohoes, NY 12047",
          frequency: "monthly",
          activation_booking_id
        };
        const subRes = await fetch(`${BASE_URL}/api/create-subscription${qsBypass()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subBody)
        });
        const subJson = await subRes.json().catch(() => ({}));
        if (!subRes.ok || !subJson.subscription_id) {
          logTest("TEST 1 — Activation", false, `create-subscription: ${subRes.status} ${JSON.stringify(subJson)}`);
        } else {
          subscription_id = subJson.subscription_id;
          const completeRes = await fetch(`${BASE_URL}/api/admin-complete-booking${qsBypass()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ booking_id: activation_booking_id })
          });
          if (!completeRes.ok) {
            logTest("TEST 1 — Activation", false, `admin-complete-booking: ${completeRes.status} (need VERCEL_PROTECTION_BYPASS for preview?)`);
          } else {
            const { data: sub } = await supabase.from("subscriptions").select("status, anchor_date").eq("id", subscription_id).single();
            const ok = sub?.status === "active" && sub?.anchor_date;
            logTest("TEST 1 — Activation", ok, ok ? `status=${sub.status} anchor_date=${sub.anchor_date}` : `subscription state: ${JSON.stringify(sub)}`);
          }
        }
      }
    }
  } catch (e) {
    logTest("TEST 1 — Activation", false, String(e.message || e));
  }

  // ---------- TEST 2 — Cycle Generation ----------
  try {
    const cronRes1 = await fetch(`${BASE_URL}/api/cron-generate-subscription-cycles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    const cronJson1 = await cronRes1.json().catch(() => ({}));
    if (!cronRes1.ok) {
      logTest("TEST 2 — Cycle Generation", false, `cron-generate: ${cronRes1.status} ${JSON.stringify(cronJson1)}`);
    } else {
      const { data: openCycles } = await supabase
        .from("subscription_cycles")
        .select("id")
        .eq("subscription_id", subscription_id)
        .eq("status", "open");
      const exactlyOne = Array.isArray(openCycles) && openCycles.length === 1;
      if (!exactlyOne) {
        logTest("TEST 2 — Cycle Generation", false, `expected 1 open cycle, got ${openCycles?.length ?? 0}`);
      } else {
        open_cycle_id = openCycles[0].id;
        const cronRes2 = await fetch(`${BASE_URL}/api/cron-generate-subscription-cycles`, {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}` }
        });
        await cronRes2.json();
        const { data: openCycles2 } = await supabase
          .from("subscription_cycles")
          .select("id")
          .eq("subscription_id", subscription_id)
          .eq("status", "open");
        const noDuplicate = Array.isArray(openCycles2) && openCycles2.length === 1;
        logTest("TEST 2 — Cycle Generation", noDuplicate, noDuplicate ? "exactly one open cycle; second run created no duplicate." : `open cycles after 2nd run: ${openCycles2?.length ?? 0}`);
      }
    }
  } catch (e) {
    logTest("TEST 2 — Cycle Generation", false, String(e.message || e));
  }

  // ---------- TEST 3 — Booking Attachment ----------
  try {
    const { data: cycle } = await supabase
      .from("subscription_cycles")
      .select("id, window_start_date, window_end_date")
      .eq("id", open_cycle_id)
      .single();
    if (!cycle?.window_start_date) {
      logTest("TEST 3 — Booking Attachment", false, "No open cycle or dates");
    } else {
      const slotStart = `${cycle.window_start_date}T10:00:00.000Z`;
      const slotEnd = `${cycle.window_start_date}T11:00:00.000Z`;
      const body = {
        customer_id,
        vehicle_id,
        service_variant_id,
        service_address: "11 Grant St, Cohoes, NY 12047",
        scheduled_start: slotStart,
        scheduled_end: slotEnd,
        subscription_id
      };
      const bookRes = await fetch(`${BASE_URL}/api/create-booking${qsBypass()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const bookJson = await bookRes.json().catch(() => ({}));
      if (!bookRes.ok) {
        logTest("TEST 3 — Booking Attachment", false, `create-booking: ${bookRes.status} ${bookJson.message || JSON.stringify(bookJson)}`);
      } else {
        last_booking_id = bookJson.bookingId;
        const { data: links } = await supabase.from("subscription_cycle_bookings").select("id").eq("booking_id", last_booking_id);
        const { data: cycleRow } = await supabase.from("subscription_cycles").select("status").eq("id", open_cycle_id).single();
        const hasLink = Array.isArray(links) && links.length >= 1;
        const statusBooked = cycleRow?.status === "booked";
        logTest("TEST 3 — Booking Attachment", hasLink && statusBooked, hasLink && statusBooked
          ? "subscription_cycle_bookings record exists; cycle status=booked"
          : `link: ${hasLink}, cycle status: ${cycleRow?.status}`);
      }
    }
  } catch (e) {
    logTest("TEST 3 — Booking Attachment", false, String(e.message || e));
  }

  // ---------- TEST 4 — Completion ----------
  try {
    const completeRes = await fetch(`${BASE_URL}/api/admin-complete-booking${qsBypass()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_id: last_booking_id })
    });
    if (!completeRes.ok) {
      logTest("TEST 4 — Completion", false, `admin-complete-booking: ${completeRes.status}`);
    } else {
      const { data: cycleRow } = await supabase.from("subscription_cycles").select("status").eq("id", open_cycle_id).single();
      const completed = cycleRow?.status === "completed";
      if (!completed) {
        logTest("TEST 4 — Completion", false, `cycle status: ${cycleRow?.status}`);
      } else {
        const cronRes = await fetch(`${BASE_URL}/api/cron-generate-subscription-cycles`, {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}` }
        });
        await cronRes.json();
        const { data: nextOpen } = await supabase
          .from("subscription_cycles")
          .select("id")
          .eq("subscription_id", subscription_id)
          .eq("status", "open");
        const nextGenerated = Array.isArray(nextOpen) && nextOpen.length >= 1;
        if (nextGenerated) open_cycle_id = nextOpen[0].id;
        logTest("TEST 4 — Completion", nextGenerated, nextGenerated ? "cycle completed; next open cycle generated." : "next open cycle not found.");
      }
    }
  } catch (e) {
    logTest("TEST 4 — Completion", false, String(e.message || e));
  }

  // ---------- TEST 5 — Missed Cycle ----------
  try {
    const yesterday = yesterdayLocal();
    const { error: upErr } = await supabase
      .from("subscription_cycles")
      .update({ window_end_date: yesterday })
      .eq("id", open_cycle_id);
    if (upErr) {
      logTest("TEST 5 — Missed Cycle", false, `update window_end_date: ${upErr.message}`);
    } else {
      const missRes = await fetch(`${BASE_URL}/api/cron-check-missed-cycles`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CRON_SECRET}` }
      });
      await missRes.json();
      const { data: c } = await supabase.from("subscription_cycles").select("status").eq("id", open_cycle_id).single();
      const { data: sub } = await supabase.from("subscriptions").select("discount_reset_required").eq("id", subscription_id).single();
      const missed = c?.status === "missed";
      const resetSet = sub?.discount_reset_required === true;
      logTest("TEST 5 — Missed Cycle", missed && resetSet, missed && resetSet
        ? "cycle status=missed; discount_reset_required=true"
        : `cycle: ${c?.status}, discount_reset_required: ${sub?.discount_reset_required}`);
    }
  } catch (e) {
    logTest("TEST 5 — Missed Cycle", false, String(e.message || e));
  }

  // ---------- TEST 6 — Reset Consumption ----------
  try {
    const cronRes = await fetch(`${BASE_URL}/api/cron-generate-subscription-cycles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    await cronRes.json();
    const { data: nextCycle } = await supabase
      .from("subscription_cycles")
      .select("id, window_start_date")
      .eq("subscription_id", subscription_id)
      .eq("status", "open")
      .limit(1)
      .single();
    if (!nextCycle?.id) {
      logTest("TEST 6 — Reset Consumption", false, "No open cycle for next booking");
    } else {
      open_cycle_id = nextCycle.id;
      const slotStart = `${nextCycle.window_start_date}T10:00:00.000Z`;
      const slotEnd = `${nextCycle.window_start_date}T11:00:00.000Z`;
      const body = {
        customer_id,
        vehicle_id,
        service_variant_id,
        service_address: "11 Grant St, Cohoes, NY 12047",
        scheduled_start: slotStart,
        scheduled_end: slotEnd,
        subscription_id
      };
      const bookRes = await fetch(`${BASE_URL}/api/create-booking${qsBypass()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const bookJson = await bookRes.json().catch(() => ({}));
      if (!bookRes.ok) {
        logTest("TEST 6 — Reset Consumption", false, `create-booking: ${bookRes.status} ${bookJson.message || ""}`);
      } else {
        last_booking_id = bookJson.bookingId;
        const { data: bookingRow } = await supabase.from("bookings").select("base_price").eq("id", last_booking_id).single();
        const { data: variantRow } = await supabase.from("service_variants").select("price").eq("id", service_variant_id).single();
        const fullPrice = variantRow?.price != null && bookingRow?.base_price != null && Number(bookingRow.base_price) === Number(variantRow.price);
        const completeRes = await fetch(`${BASE_URL}/api/admin-complete-booking${qsBypass()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ booking_id: last_booking_id })
        });
        if (!completeRes.ok) {
          logTest("TEST 6 — Reset Consumption", false, `admin-complete-booking: ${completeRes.status}`);
        } else {
          const { data: sub } = await supabase.from("subscriptions").select("discount_reset_required").eq("id", subscription_id).single();
          const resetCleared = sub?.discount_reset_required === false;
          logTest("TEST 6 — Reset Consumption", fullPrice && resetCleared, fullPrice && resetCleared
            ? "base_price matches full price; discount_reset_required=false after completion"
            : `fullPrice: ${fullPrice}, discount_reset_required: ${sub?.discount_reset_required}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 6 — Reset Consumption", false, String(e.message || e));
  }

  // ---------- TEST 7 — Pushback ----------
  try {
    const cronRes = await fetch(`${BASE_URL}/api/cron-generate-subscription-cycles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    await cronRes.json();
    const { data: openCycle } = await supabase
      .from("subscription_cycles")
      .select("id, pushback_end_date")
      .eq("subscription_id", subscription_id)
      .eq("status", "open")
      .limit(1)
      .single();
    if (!openCycle?.id) {
      logTest("TEST 7 — Pushback", false, "No open cycle for pushback");
    } else {
      const pushRes1 = await fetch(`${BASE_URL}/api/subscription-pushback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: openCycle.id })
      });
      const pushJson1 = await pushRes1.json().catch(() => ({}));
      if (!pushRes1.ok) {
        logTest("TEST 7 — Pushback", false, `first pushback: ${pushRes1.status} ${pushJson1.message || ""}`);
      } else {
        const { data: after } = await supabase.from("subscription_cycles").select("pushback_used, pushback_end_date").eq("id", openCycle.id).single();
        const used = after?.pushback_used === true;
        const extended = after?.pushback_end_date && after.pushback_end_date !== openCycle.pushback_end_date;
        if (!used) {
          logTest("TEST 7 — Pushback", false, "pushback_used not true after first call");
        } else {
          const pushRes2 = await fetch(`${BASE_URL}/api/subscription-pushback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cycle_id: openCycle.id })
          });
          const pushJson2 = await pushRes2.json().catch(() => ({}));
          const secondFails = !pushRes2.ok;
          logTest("TEST 7 — Pushback", extended && secondFails, extended && secondFails
            ? "pushback_used=true, window extended; second pushback correctly failed"
            : `extended: ${extended}, second call ok: ${pushRes2.ok}`);
        }
      }
    }
  } catch (e) {
    logTest("TEST 7 — Pushback", false, String(e.message || e));
  }

  // ---------- Summary ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n========== SUMMARY ==========");
  console.log(`Total: ${results.length}  PASS: ${passed}  FAIL: ${failed}`);
  results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
