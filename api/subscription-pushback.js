import { createClient } from "@supabase/supabase-js";
import { addBusinessDays } from "./_subscriptions/lifecycle.js";

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
  if (req.method !== "POST") return res.status(405).end();

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const cycleId = body.cycle_id;

    if (!cycleId) {
      return res.status(400).json({ ok: false, message: "Missing cycle_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: cycle, error: fetchErr } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id, status, pushback_used, window_end_date")
      .eq("id", cycleId)
      .single();

    if (fetchErr || !cycle) {
      return res.status(404).json({ ok: false, message: "Cycle not found." });
    }
    if (cycle.status !== "open") {
      return res.status(400).json({ ok: false, message: "Cycle is not open for pushback." });
    }
    if (cycle.pushback_used) {
      return res.status(400).json({ ok: false, message: "Pushback already used for this cycle." });
    }

    const cycleEnd = cycle.window_end_date;
    if (!cycleEnd) {
      return res.status(400).json({ ok: false, message: "Cycle has no end date." });
    }

    const pushbackWindowEnd = addBusinessDays(cycleEnd, 5);

    const { error: updateErr } = await supabase
      .from("subscription_cycles")
      .update({
        pushback_used: true,
        pushback_end_date: pushbackWindowEnd
      })
      .eq("id", cycleId);

    if (updateErr) {
      console.error("[subscription-pushback] update error", updateErr);
      return res.status(500).json({ ok: false, message: "Pushback update failed." });
    }

    console.log("CYCLE_PUSHBACK", {
      cycle_id: cycleId,
      subscription_id: cycle.subscription_id,
      pushback_end_date: pushbackWindowEnd
    });

    return res.status(200).json({
      ok: true,
      pushback_end_date: pushbackWindowEnd
    });
  } catch (err) {
    console.error("subscription-pushback error:", err);
    return res.status(500).json({ ok: false, message: "Server error." });
  }
}
