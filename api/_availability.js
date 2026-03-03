import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Fetches calendar events and pending/confirmed bookings in [timeMin, timeMax],
 * then returns whether the slot [startIso, endIso] does not overlap any block.
 * Used by check-availability.js and create-booking.js.
 */
export async function checkAvailability(startIso, endIso) {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  );

  const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
  const saJson = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const decoded = Buffer.from(saJson, "base64").toString("utf-8");
  const creds = JSON.parse(decoded);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
  });
  const calendar = google.calendar({ version: "v3", auth });

  const resp = await calendar.events.list({
    calendarId,
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 250
  });
  const items = resp.data.items || [];

  const blocks = [];
  for (const e of items) {
    if (e.status === "cancelled") continue;
    if (e.start?.dateTime && e.end?.dateTime) {
      blocks.push({ start: e.start.dateTime, end: e.end.dateTime });
      continue;
    }
    if (e.start?.date && e.end?.date) {
      const day = e.start.date;
      blocks.push({ start: `${day}T08:00:00`, end: `${day}T18:00:00` });
    }
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select("scheduled_start, scheduled_end")
    .in("status", ["confirmed", "pending"])
    .lt("scheduled_start", endIso)
    .gt("scheduled_end", startIso);

  for (const b of bookings || []) {
    blocks.push({ start: b.scheduled_start, end: b.scheduled_end });
  }

  for (const b of blocks) {
    if (b.start < endIso && b.end > startIso) return false;
  }
  return true;
}
