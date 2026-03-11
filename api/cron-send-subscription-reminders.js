import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";
import { sendCycleReminder1EmailCore } from "../lib/email/sendCycleReminder1Email.js";
import { sendCycleReminder2EmailCore } from "../lib/email/sendCycleReminder2Email.js";

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

/** Add n calendar days to YYYY-MM-DD. n may be negative. */
function addCalendarDays(dateStr, n) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${month}-${day}`;
}

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

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const today = todayLocal();

    const { data: openCycles, error: listErr } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id, window_end_date, pushback_used, pushback_end_date, reminder_1_sent_at, reminder_2_sent_at")
      .eq("status", "open");

    if (listErr) {
      console.error("[REMINDERS] List open cycles failed", listErr);
      return res.status(500).json({ error: "Internal error" });
    }

    if (!openCycles?.length) {
      console.log("[REMINDERS] No open cycles");
      return res.status(200).json({ ok: true, reminder_1: 0, reminder_2: 0 });
    }

    let sent1 = 0;
    let sent2 = 0;

    for (const cycle of openCycles) {
      const effectiveEnd = getEffectiveWindowEnd(cycle);
      if (!effectiveEnd) continue;

      const { data: linked } = await supabase
        .from("subscription_cycle_bookings")
        .select("id")
        .eq("cycle_id", cycle.id)
        .limit(1)
        .maybeSingle();

      if (linked) continue;

      const reminder1Date = addCalendarDays(effectiveEnd, -3);
      const reminder2Date = addCalendarDays(effectiveEnd, -1);

      if (today === reminder1Date && !cycle.reminder_1_sent_at) {
        try {
          await sendCycleReminder1EmailCore(cycle.id);
          const { error: updateErr } = await supabase
            .from("subscription_cycles")
            .update({ reminder_1_sent_at: new Date().toISOString() })
            .eq("id", cycle.id);
          if (updateErr) {
            console.error("[REMINDERS] reminder_1_sent_at update failed", cycle.id, updateErr);
          } else {
            sent1 += 1;
            console.log("[EMAIL] type=cycle-reminder-1 cycle_id=" + cycle.id + " status=success");
          }
        } catch (emailErr) {
          console.error("[EMAIL] type=cycle-reminder-1 cycle_id=" + cycle.id + " status=failure", emailErr);
        }
      }

      if (today === reminder2Date && !cycle.reminder_2_sent_at) {
        try {
          await sendCycleReminder2EmailCore(cycle.id);
          const { error: updateErr } = await supabase
            .from("subscription_cycles")
            .update({ reminder_2_sent_at: new Date().toISOString() })
            .eq("id", cycle.id);
          if (updateErr) {
            console.error("[REMINDERS] reminder_2_sent_at update failed", cycle.id, updateErr);
          } else {
            sent2 += 1;
            console.log("[EMAIL] type=cycle-reminder-2 cycle_id=" + cycle.id + " status=success");
          }
        } catch (emailErr) {
          console.error("[EMAIL] type=cycle-reminder-2 cycle_id=" + cycle.id + " status=failure", emailErr);
        }
      }
    }

    return res.status(200).json({ ok: true, reminder_1: sent1, reminder_2: sent2 });
  } catch (err) {
    console.error("cron-send-subscription-reminders error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
