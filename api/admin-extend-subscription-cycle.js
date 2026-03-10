import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { addBusinessDays, PUSHBACK_BUSINESS_DAYS, getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";
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
    console.error("admin-extend-subscription-cycle: auth failed", err.message);
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

    const { subscription, activeCycle, activeCycleBooking } = resolved;

    if (!activeCycle) {
      return res.status(400).json({ error: "No current open cycle for this subscription." });
    }
    if (activeCycle.status !== "open") {
      return res.status(400).json({ error: "Current cycle is not open. Only open cycles can be extended." });
    }
    if (activeCycleBooking) {
      return res.status(400).json({ error: "Cycle already has a linked booking. Cannot extend." });
    }
    if (activeCycle.pushback_used) {
      return res.status(400).json({ error: "Pushback has already been used for this cycle." });
    }

    const pushback_end_date = addBusinessDays(activeCycle.window_end_date, PUSHBACK_BUSINESS_DAYS);
    if (!pushback_end_date) {
      console.error("admin-extend-subscription-cycle: invalid window_end_date", activeCycle.window_end_date);
      return res.status(500).json({ error: "Invalid cycle date." });
    }

    const { data: updatedCycle, error: updateErr } = await supabase
      .from("subscription_cycles")
      .update({
        pushback_used: true,
        pushback_end_date,
        free_pushback: true
      })
      .eq("id", activeCycle.id)
      .select("id, cycle_index, status, window_start_date, window_end_date, pushback_used, pushback_end_date, free_pushback")
      .single();

    if (updateErr) {
      console.error("admin-extend-subscription-cycle error:", updateErr);
      return res.status(500).json({ error: "Failed to extend cycle." });
    }

    return res.status(200).json({
      ok: true,
      message: "Cycle extended. No fee applied.",
      cycle: {
        id: updatedCycle.id,
        cycle_index: updatedCycle.cycle_index,
        status: updatedCycle.status,
        window_start_date: updatedCycle.window_start_date,
        window_end_date: updatedCycle.window_end_date,
        pushback_used: updatedCycle.pushback_used,
        pushback_end_date: updatedCycle.pushback_end_date,
        free_pushback: updatedCycle.free_pushback,
        effective_window_end: getEffectiveWindowEnd(updatedCycle)
      }
    });
  } catch (err) {
    console.error("admin-extend-subscription-cycle error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
