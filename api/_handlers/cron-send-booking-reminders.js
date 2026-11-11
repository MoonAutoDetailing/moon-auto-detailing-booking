import { createClient } from "@supabase/supabase-js";
import { sendBookingReminder48EmailCore } from "../../lib/email/sendBookingReminder48Email.js";
import { sendBookingReminder8EmailCore } from "../../lib/email/sendBookingReminder8Email.js";
import { runCrewMorningEmails } from "../_crewMorning.js";
import { sendMorningEmail } from "../../lib/email/crewEmails.js";
import { todayNY } from "../_subscriptions/lifecycle.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const H_MS = 60 * 60 * 1000;

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

    const now = new Date();
    const nowMs = now.getTime();

    // Runs once a day at 11:00 UTC (6am EST / 7am EDT; Hobby crons may fire any time in that hour).
    // "2 days" reminder: jobs on the day after tomorrow (now+36h..now+60h covers that whole business day).
    // "Today" reminder: jobs later today (business hours end by 6pm, well inside now..now+16h).
    const window48Start = new Date(nowMs + 36 * H_MS).toISOString();
    const window48End = new Date(nowMs + 60 * H_MS).toISOString();
    const window8Start = now.toISOString();
    const window8End = new Date(nowMs + 16 * H_MS).toISOString();


    let sent48 = 0;
    let sent8 = 0;

    const { data: for48, error: err48 } = await supabase
      .from("bookings")
      .select("id")
      .eq("status", "confirmed")
      .is("reminder_48_sent_at", null)
      .gte("scheduled_start", window48Start)
      .lte("scheduled_start", window48End);

    if (err48) {
      console.error("[REMINDERS] 48h booking list failed", err48);
      return res.status(500).json({ error: "Internal error" });
    }

    const candidates48 = (for48 || []);
    for (const row of candidates48) {
      try {
        await sendBookingReminder48EmailCore(row.id);
        const { error: updateErr } = await supabase
          .from("bookings")
          .update({ reminder_48_sent_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updateErr) {
          console.error("[REMINDERS] reminder_48_sent_at update failed", row.id, updateErr);
        } else {
          sent48 += 1;
          console.log("[EMAIL] type=booking-reminder-48 booking_id=" + row.id + " status=success");
        }
      } catch (emailErr) {
        console.error("[EMAIL] type=booking-reminder-48 booking_id=" + row.id + " status=failure", emailErr);
      }
    }

    const { data: for8, error: err8 } = await supabase
      .from("bookings")
      .select("id")
      .eq("status", "confirmed")
      .is("reminder_8_sent_at", null)
      .gte("scheduled_start", window8Start)
      .lte("scheduled_start", window8End);

    if (err8) {
      console.error("[REMINDERS] 8h booking list failed", err8);
      return res.status(500).json({ error: "Internal error" });
    }

    const candidates8 = (for8 || []);
    for (const row of candidates8) {
      try {
        await sendBookingReminder8EmailCore(row.id);
        const { error: updateErr } = await supabase
          .from("bookings")
          .update({ reminder_8_sent_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updateErr) {
          console.error("[REMINDERS] reminder_8_sent_at update failed", row.id, updateErr);
        } else {
          sent8 += 1;
          console.log("[EMAIL] type=booking-reminder-8 booking_id=" + row.id + " status=success");
        }
      } catch (emailErr) {
        console.error("[EMAIL] type=booking-reminder-8 booking_id=" + row.id + " status=failure", emailErr);
      }
    }

    // Crew "today's jobs" email; never blocks customer reminders.
    let crew = { sent: 0, failed: 0 };
    try {
      crew = await runCrewMorningEmails({ sb: supabase, today: todayNY(), send: sendMorningEmail });
    } catch (crewErr) {
      console.error("[CREW_MORNING] failed", crewErr);
    }

    return res.status(200).json({ ok: true, reminder_48: sent48, reminder_8: sent8, crew_morning: crew.sent });
  } catch (err) {
    console.error("cron-send-booking-reminders error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
