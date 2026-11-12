import { createClient } from "@supabase/supabase-js";
import { isCycleAutomationEnabled } from "../_subscriptions/flags.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { runGenerateCycles } from "../_subscriptions/cycleJobs.js";
import { sendCycleOpenEmailCore } from "../../lib/email/sendCycleOpenEmail.js";
import { isCronRequest } from "../_cronAuth.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// Creates each member's next cycle 7 days before its window and sends the "book now" email once.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isCycleAutomationEnabled()) {
    console.log("[CYCLE_AUTOMATION] paused; skipping cron-generate-subscription-cycles");
    return res.status(200).json({ ok: true, paused: true });
  }

  try {
    const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const today = todayNY();
    const result = await runGenerateCycles({ sb, today, send: { cycleOpen: sendCycleOpenEmailCore } });
    console.log("[CYCLE_GENERATOR]", { today, ...result });
    return res.status(200).json({ ok: true, today, ...result });
  } catch (err) {
    console.error("cron-generate-subscription-cycles error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
