import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd, addBusinessDays, PUSHBACK_BUSINESS_DAYS } from "./_subscriptions/lifecycle.js";
import { resolveSubscriptionByToken } from "./_subscriptions/resolveSubscriptionByToken.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
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
        free_pushback: activeCycle.free_pushback
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
      free_pushback: updatedCycle.free_pushback
    });

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
        effective_window_end: getEffectiveWindowEnd(cycle)
      }
    });
  } catch (err) {
    console.error("customer-subscription-pushback error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
