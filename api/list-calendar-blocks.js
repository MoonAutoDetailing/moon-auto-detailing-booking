console.log("list-calendar-blocks: file loaded");
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";


/**
 * Read-only endpoint: returns confirmed booking blocks from Google Calendar. 
 * This is intentionally minimal and redacts event details.
 *
 * Query params:
 *   timeMin: ISO string (required)
 *   timeMax: ISO string (required)
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  console.log("list-calendar-blocks: handler entered");
  // CORS (same-origin use; permissive enough for your own site)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const timeMin = req.query.timeMin;
    const timeMax = req.query.timeMax;
    if (!timeMin || !timeMax) return res.status(400).json({ error: "timeMin and timeMax are required" });

    const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
    const saJson = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
const decoded = Buffer.from(saJson, "base64").toString("utf-8");
const creds = JSON.parse(decoded);


    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });
    const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);


    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: 2500,
    });

    const items = resp.data.items || [];

    // =========================
// 1) Confirmed blocks from Google Calendar
// =========================
const confirmedBlocks = items
  .filter((e) => e.status !== "cancelled")
  .map((e) => {
    if (e.start?.dateTime && e.end?.dateTime) {
      return {
        start: e.start.dateTime,
        end: e.end.dateTime,
        status: "confirmed"
      };
    }

    if (e.start?.date && e.end?.date) {
      const day = e.start.date;
      return {
        start: `${day}T08:00:00`,
        end: `${day}T18:00:00`,
        status: "confirmed"
      };
    }

    return null;
  })
  .filter(Boolean);

// pending bookings — OVERLAP SAFE (must match check-availability logic)
const { data: pendingBookings, error: pendingError } = await supabase
  .from("bookings")
  .select("scheduled_start, scheduled_end")
  .eq("status", "pending")
  .lt("scheduled_start", timeMax)   // starts before window ends
  .gt("scheduled_end", timeMin);    // ends after window begins

if (pendingError) throw pendingError;


const pendingBlocks = (pendingBookings || []).map(b => ({
  start: b.scheduled_start,
  end: b.scheduled_end,
  status: "pending"
}));

// =========================
// 3) Merge and return
// =========================
return res.status(200).json({
  blocks: [...confirmedBlocks, ...pendingBlocks]
});

} catch (e) {
  console.error("list-calendar-blocks error:", e);
  return res.status(500).json({ error: e?.message || "Server error" });
}
}
