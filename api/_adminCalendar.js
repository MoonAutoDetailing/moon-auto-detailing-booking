import { google } from "googleapis";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Get Google Calendar API client with write scope. Used by admin availability endpoints only.
 */
async function getCalendarClient() {
  const raw = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const creds = JSON.parse(decoded);
  const privateKey = creds.private_key?.replace(/\\n/g, "\n");
  if (!creds.client_email || !privateKey) {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/calendar"]
  );
  await auth.authorize();
  return google.calendar({ version: "v3", auth });
}

/**
 * Create an all-day block event for a date. Used for blocked full-day overrides.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{ eventId: string }}
 */
export async function createAllDayBlock(dateStr) {
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
  const calendar = await getCalendarClient();
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const endDateStr = d.toISOString().slice(0, 10);
  const event = {
    summary: "Unavailable (blocked)",
    description: "Admin blocked this date for availability.",
    start: { date: dateStr },
    end: { date: endDateStr },
  };
  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });
  return { eventId: res.data.id };
}

/**
 * Delete a calendar event by ID. Used when clearing a blocked override.
 * @param {string} eventId
 */
export async function deleteCalendarEvent(eventId) {
  if (!eventId || !eventId.trim()) return;
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId,
    eventId: eventId.trim(),
  });
}
