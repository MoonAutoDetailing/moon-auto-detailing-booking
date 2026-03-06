import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";
import { sendMissedCycleEmailCore } from "../lib/email/sendMissedCycleEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const today = todayLocal();

    const { data: openCycles } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id, window_end_date, pushback_used, pushback_end_date")
      .eq("status", "open");

    if (!openCycles?.length) {
      console.log("[MISSED_CYCLES] No open cycles");
      return res.status(200).json({ ok: true, marked: 0 });
    }

    let marked = 0;
    for (const cycle of openCycles) {
      const expiration = getEffectiveWindowEnd(cycle);
      if (!expiration || today <= expiration) continue;

      const { error: updateCycleErr } = await supabase
        .from("subscription_cycles")
        .update({ status: "missed" })
        .eq("id", cycle.id);

      if (updateCycleErr) {
        console.error("[MISSED_CYCLES] Update cycle failed", cycle.id, updateCycleErr);
        continue;
      }

      const { data: sub } = await supabase
        .from("subscriptions")
        .select("id, discount_reset_required")
        .eq("id", cycle.subscription_id)
        .single();

      if (sub && !sub.discount_reset_required) {
        await supabase
          .from("subscriptions")
          .update({ discount_reset_required: true })
          .eq("id", cycle.subscription_id);
      }

      console.log("CYCLE_MISSED", { cycle_id: cycle.id, subscription_id: cycle.subscription_id });
      if (sub && !sub.discount_reset_required) {
        console.log("DISCOUNT_RESET_TRIGGERED", { subscription_id: cycle.subscription_id });
      }
      marked += 1;

      try {
        await sendMissedCycleEmailCore(cycle.id);
        console.log("[EMAIL] type=missed-cycle cycle_id=" + cycle.id + " status=success");
      } catch (emailErr) {
        console.error("[EMAIL] type=missed-cycle cycle_id=" + cycle.id + " status=failure", emailErr);
      }
    }

    return res.status(200).json({ ok: true, marked });
  } catch (err) {
    console.error("cron-check-missed-cycles error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
