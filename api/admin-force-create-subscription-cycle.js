import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import {
  getCycleStartDate,
  getCycleEndDate,
  getNextCycleSequence
} from "./_subscriptions/lifecycle.js";
import { resolveSubscriptionById } from "./_subscriptions/resolveSubscriptionById.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-force-create-subscription-cycle: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const subscriptionId = req.body?.subscription_id || req.body?.id;
  if (!subscriptionId) {
    return res.status(400).json({ error: "Missing subscription_id" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionById(supabase, subscriptionId);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription, activeCycle } = resolved;

    if (subscription.status !== "active") {
      return res.status(400).json({ error: "Only active subscriptions can have cycles force-created." });
    }
    if (activeCycle) {
      return res.status(400).json({ error: "An open or booked cycle already exists. Resolve it before creating a new cycle." });
    }

    const { data: maxRow } = await supabase
      .from("subscription_cycles")
      .select("cycle_index")
      .eq("subscription_id", subscriptionId)
      .order("cycle_index", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextSeq = getNextCycleSequence(maxRow?.cycle_index ?? null);
    const cycleStart = getCycleStartDate(subscription.anchor_date, subscription.frequency, nextSeq);
    const cycleEnd = getCycleEndDate(cycleStart, subscription.frequency);

    if (!cycleStart || !cycleEnd) {
      return res.status(400).json({ error: "Invalid cadence or anchor date; cannot compute cycle window." });
    }

    const { data: newCycle, error: insertErr } = await supabase
      .from("subscription_cycles")
      .insert({
        subscription_id: subscriptionId,
        status: "open",
        window_start_date: cycleStart,
        window_end_date: cycleEnd,
        cycle_index: nextSeq,
        pushback_used: false
      })
      .select("id, cycle_index, window_start_date, window_end_date, status")
      .single();

    if (insertErr) {
      console.error("admin-force-create-subscription-cycle error:", insertErr);
      return res.status(500).json({ error: "Failed to create cycle. Duplicate unresolved cycle may exist." });
    }

    return res.status(200).json({
      ok: true,
      message: "Cycle created.",
      cycle: {
        id: newCycle.id,
        cycle_index: newCycle.cycle_index,
        window_start_date: newCycle.window_start_date,
        window_end_date: newCycle.window_end_date,
        status: newCycle.status
      }
    });
  } catch (err) {
    console.error("admin-force-create-subscription-cycle error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
