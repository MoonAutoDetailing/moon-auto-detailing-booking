import { google } from "googleapis";

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

function safeJsonParse(str, name) {
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

export default async function handler(req, res) {
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

    // Handle private key newlines if stored with escaped \n
    const creds = safeJsonParse(saJson, "GOOGLE_SERVICE_ACCOUNT_JSON");
    if (creds.private_key && typeof creds.private_key === "string") {
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

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

    // Return blocks only (start/end). If an all-day event exists, ignore it.
    const blocks = items
  .filter((e) => e.status !== "cancelled")
  .map((e) => {
    // Timed events (normal case)
    if (e.start?.dateTime && e.end?.dateTime) {
      return {
        start: e.start.dateTime,
        end: e.end.dateTime
      };
    }

    // All-day events → block full business day
    if (e.start?.date && e.end?.date) {
      const day = e.start.date; // YYYY-MM-DD
      return {
        start: `${day}T08:00:00`,
        end: `${day}T18:00:00`
      };
    }

    return null;
  })
  .filter(Boolean);


    return res.status(200).json({ blocks });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
