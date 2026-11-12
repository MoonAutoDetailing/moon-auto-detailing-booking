import { createClient } from "@supabase/supabase-js";
import { isCycleAutomationEnabled } from "../_subscriptions/flags.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { runCheckMissedCycles } from "../_subscriptions/cycleJobs.js";
import { sendMissedCycleEmailCore } from "../../lib/email/sendMissedCycleEmail.js";
import { isCronRequest } from "../_cronAuth.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// Marks open cycles missed after their window ends (unless a matching booking exists) and emails once.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isCycleAutomationEnabled()) {
    console.log("[CYCLE_AUTOMATION] paused; skipping cron-check-missed-cycles");
    return res.status(200).json({ ok: true, paused: true });
  }

  try {
    const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const today = todayNY();
    const result = await runCheckMissedCycles({ sb, today, send: { missed: sendMissedCycleEmailCore } });
    console.log("[MISSED_CYCLES]", { today, ...result });
    return res.status(200).json({ ok: true, today, ...result });
  } catch (err) {
    console.error("cron-check-missed-cycles error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
