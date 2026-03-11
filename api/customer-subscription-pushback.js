import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd, addBusinessDays, PUSHBACK_BUSINESS_DAYS } from "./_subscriptions/lifecycle.js";
import { resolveSubscriptionByToken } from "./_subscriptions/resolveSubscriptionByToken.js";
import { sendCyclePushbackEmailCore } from "../lib/email/sendCyclePushbackEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Returns business days (YYYY-MM-DD) from start through end inclusive. Skips Saturday/Sunday.
 */
function getBusinessDaysInRange(startDateStr, endDateStr) {
  const m = startDateStr && startDateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return [];
  let d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  const endM = endDateStr && endDateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!endM) return [];
  const endDate = new Date(parseInt(endM[1], 10), parseInt(endM[2], 10) - 1, parseInt(endM[3], 10));
  const out = [];
  while (d <= endDate) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const y = d.getFullYear();
      const month = (d.getMonth() + 1).toString().padStart(2, "0");
      const dayNum = d.getDate().toString().padStart(2, "0");
      out.push(`${y}-${month}-${dayNum}`);
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase && typeof envBase === "string" && envBase.trim()) {
    return envBase.trim().replace(/\/$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"];
  if (host) return `${proto}://${host}`;
  return null;
}

/**
 * Call real get-availability for one day. Returns { slotsCount, routing_error, failed }.
 * failed true = non-200 or throw or routing_error; do not apply pushback.
 */
async function fetchSlotsForDay(baseUrl, day, durationMinutes, serviceAddress) {
  const params = new URLSearchParams({
    day,
    duration_minutes: String(durationMinutes),
    service_address: serviceAddress
  });
  const url = `${baseUrl}/api/get-availability?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { slotsCount: 0, routing_error: false, failed: true };
  }
  if (data.routing_error === true) {
    return { slotsCount: 0, routing_error: true, failed: true };
  }
  const slots = Array.isArray(data.slots) ? data.slots : [];
  return { slotsCount: slots.length, routing_error: false, failed: false };
}

/**
 * Determine free_pushback: true only if every business day in the cycle window had zero valid slots.
 * Uses the real get-availability endpoint. Stops early if any day has slots.
 */
async function computeFreePushback(req, activeCycle, subscription) {
  const durationMinutes = subscription.service_variants?.duration_minutes;
  const numDuration = Number(durationMinutes);
  if (!Number.isFinite(numDuration) || numDuration <= 0) {
    return { free_pushback: false, error: "Invalid or missing service duration for availability check." };
  }
  const defaultAddress = subscription.default_address;
  if (!defaultAddress || typeof defaultAddress !== "string" || !defaultAddress.trim()) {
    return { free_pushback: false, error: "Missing default address for availability check." };
  }
  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    return { free_pushback: false, error: "Unable to determine request base URL." };
  }
  const businessDays = getBusinessDaysInRange(activeCycle.window_start_date, activeCycle.window_end_date);
  if (businessDays.length === 0) {
    return { free_pushback: true, evaluated_window_start: activeCycle.window_start_date, evaluated_window_end: activeCycle.window_end_date, evaluated_business_days: 0, had_zero_valid_slots: true };
  }
  const address = defaultAddress.trim();
  for (const day of businessDays) {
    const result = await fetchSlotsForDay(baseUrl, day, numDuration, address);
    if (result.failed) {
      return { free_pushback: false, error: "Unable to determine pushback fee eligibility right now. Please try again." };
    }
    if (result.slotsCount > 0) {
      return { free_pushback: false, evaluated_window_start: activeCycle.window_start_date, evaluated_window_end: activeCycle.window_end_date, evaluated_business_days: businessDays.length, had_zero_valid_slots: false };
    }
  }
  return { free_pushback: true, evaluated_window_start: activeCycle.window_start_date, evaluated_window_end: activeCycle.window_end_date, evaluated_business_days: businessDays.length, had_zero_valid_slots: true };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = req.body?.token ?? req.query?.token;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionByToken(supabase, token);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription, activeCycle, activeCycleBooking } = resolved;

    if (!subscription) {
      return res.status(400).json({ error: "Subscription not found." });
    }
    if (subscription.status !== "active") {
      return res.status(400).json({ error: "Subscription is not active." });
    }
    if (!activeCycle) {
      return res.status(400).json({ error: "No active cycle for this subscription." });
    }
    if (activeCycle.status !== "open") {
      return res.status(400).json({ error: "Current cycle is not open for pushback." });
    }
    if (activeCycle.pushback_used) {
      return res.status(400).json({ error: "Pushback has already been used for this cycle." });
    }
    if (activeCycleBooking) {
      return res.status(400).json({ error: "Cannot push back after a booking is already scheduled." });
    }

    const durationMinutes = subscription.service_variants?.duration_minutes;
    const numDuration = Number(durationMinutes);
    if (!Number.isFinite(numDuration) || numDuration <= 0) {
      return res.status(500).json({ error: "Invalid or missing service duration. Cannot determine pushback eligibility." });
    }
    const defaultAddress = subscription.default_address;
    if (!defaultAddress || typeof defaultAddress !== "string" || !defaultAddress.trim()) {
      return res.status(500).json({ error: "Missing default address. Cannot determine pushback eligibility." });
    }

    const waiverResult = await computeFreePushback(req, activeCycle, subscription);
    if (waiverResult.error) {
      return res.status(500).json({ error: waiverResult.error });
    }

    const free_pushback = waiverResult.free_pushback === true;

    const pushback_end_date = addBusinessDays(activeCycle.window_end_date, PUSHBACK_BUSINESS_DAYS);
    if (!pushback_end_date) {
      console.error("customer-subscription-pushback error: invalid window_end_date", activeCycle.window_end_date);
      return res.status(500).json({ error: "Invalid cycle date." });
    }

    const { data: updatedCycle, error: updateErr } = await supabase
      .from("subscription_cycles")
      .update({
        pushback_used: true,
        pushback_end_date,
        free_pushback
      })
      .eq("id", activeCycle.id)
      .select("id, cycle_index, status, window_start_date, window_end_date, pushback_used, pushback_end_date, free_pushback")
      .single();

    if (updateErr) {
      console.error("customer-subscription-pushback error:", updateErr);
      return res.status(500).json({ error: "Failed to apply pushback." });
    }

    console.log("CYCLE_PUSHBACK", {
      subscription_id: subscription.id,
      cycle_id: updatedCycle.id,
      cycle_index: updatedCycle.cycle_index,
      pushback_used: updatedCycle.pushback_used,
      pushback_end_date: updatedCycle.pushback_end_date,
      free_pushback: updatedCycle.free_pushback,
      evaluated_window_start: waiverResult.evaluated_window_start,
      evaluated_window_end: waiverResult.evaluated_window_end,
      evaluated_business_days: waiverResult.evaluated_business_days,
      had_zero_valid_slots: waiverResult.had_zero_valid_slots
    });

    try {
      await sendCyclePushbackEmailCore(updatedCycle.id, token);
      console.log("[EMAIL] type=cycle-pushback cycle_id=" + updatedCycle.id + " status=success");
    } catch (emailErr) {
      console.error("[EMAIL] type=cycle-pushback cycle_id=" + updatedCycle.id + " status=failure", emailErr);
    }

    const cycle = updatedCycle;
    return res.status(200).json({
      ok: true,
      message: "Cycle pushback applied.",
      cycle: {
        id: cycle.id,
        cycle_index: cycle.cycle_index,
        status: cycle.status,
        window_start_date: cycle.window_start_date,
        window_end_date: cycle.window_end_date,
        pushback_used: cycle.pushback_used,
        pushback_end_date: cycle.pushback_end_date,
        free_pushback: cycle.free_pushback,
        effective_window_end: getEffectiveWindowEnd(cycle)
      }
    });
  } catch (err) {
    console.error("customer-subscription-pushback error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
