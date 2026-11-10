import { createClient } from "@supabase/supabase-js";
import { isCycleAutomationEnabled } from "../_subscriptions/flags.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { runSendReminders } from "../_subscriptions/cycleJobs.js";
import { sendCycleReminder1EmailCore } from "../../lib/email/sendCycleReminder1Email.js";
import { sendCycleReminder2EmailCore } from "../../lib/email/sendCycleReminder2Email.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// Reminds members with an open, unbooked cycle 3 days and 1 day before the window closes.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  const cronHeader = req.headers["x-vercel-cron"];
  const validBearer = authHeader && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const validVercelCron = cronHeader === "1";
  if (!validBearer && !validVercelCron) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isCycleAutomationEnabled()) {
    console.log("[CYCLE_AUTOMATION] paused; skipping cron-send-subscription-reminders");
    return res.status(200).json({ ok: true, paused: true });
  }

  try {
    const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const today = todayNY();
    const result = await runSendReminders({ sb, today, send: { reminder1: sendCycleReminder1EmailCore, reminder2: sendCycleReminder2EmailCore } });
    console.log("[SUBSCRIPTION_REMINDERS]", { today, ...result });
    return res.status(200).json({ ok: true, today, ...result });
  } catch (err) {
    console.error("cron-send-subscription-reminders error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
