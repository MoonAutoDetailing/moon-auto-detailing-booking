import { createClient } from "@supabase/supabase-js";
import {
  getCycleStartDate,
  getCycleEndDate,
  getNextCycleSequence
} from "./_subscriptions/lifecycle.js";
import { sendCycleOpenEmailCore } from "../lib/email/sendCycleOpenEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  const cronHeader = req.headers["x-vercel-cron"];

  const validBearer =
    authHeader &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  const validVercelCron = cronHeader === "1";

  if (!validBearer && !validVercelCron) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: subscriptions } = await supabase
      .from("subscriptions")
      .select("id, anchor_date, frequency")
      .eq("status", "active");

    if (!subscriptions?.length) {
      console.log("[CYCLE_GENERATOR] No active subscriptions");
      return res.status(200).json({ ok: true, generated: 0 });
    }

    let generated = 0;
    for (const sub of subscriptions) {
      const { data: unresolved } = await supabase
        .from("subscription_cycles")
        .select("id")
        .eq("subscription_id", sub.id)
        .in("status", ["open", "booked"])
        .limit(1)
        .maybeSingle();

      if (unresolved) {
        continue;
      }

      const { data: maxRow } = await supabase
        .from("subscription_cycles")
        .select("cycle_index")
        .eq("subscription_id", sub.id)
        .order("cycle_index", { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextSeq = getNextCycleSequence(maxRow?.cycle_index ?? null);
      const cycleStart = getCycleStartDate(sub.anchor_date, sub.frequency, nextSeq);
      const cycleEnd = getCycleEndDate(cycleStart, sub.frequency);

      if (!cycleStart || !cycleEnd) {
        console.warn("[CYCLE_GENERATOR] Skip subscription", sub.id, "date calc failed");
        continue;
      }

      const { data: newCycle, error: insertErr } = await supabase
        .from("subscription_cycles")
        .insert({
          subscription_id: sub.id,
          status: "open",
          window_start_date: cycleStart,
          window_end_date: cycleEnd,
          cycle_index: nextSeq,
          pushback_used: false
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error("[CYCLE_GENERATOR] Insert failed", sub.id, insertErr);
        continue;
      }

      console.log("CYCLE_GENERATED", {
        subscription_id: sub.id,
        cycle_id: newCycle.id,
        cycle_index: nextSeq,
        window_start_date: cycleStart,
        window_end_date: cycleEnd
      });
      generated += 1;

      try {
        await sendCycleOpenEmailCore(newCycle.id);
        console.log("[EMAIL] type=cycle-open cycle_id=" + newCycle.id + " status=success");
      } catch (emailErr) {
        console.error("[EMAIL] type=cycle-open cycle_id=" + newCycle.id + " status=failure", emailErr);
      }
    }

    return res.status(200).json({ ok: true, generated });
  } catch (err) {
    console.error("cron-generate-subscription-cycles error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
