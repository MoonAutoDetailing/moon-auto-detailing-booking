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

const BUSINESS_TZ = "America/New_York";

function getDayStartUtcForBusinessTZ(dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const parts = dtf.formatToParts(probe);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second)
  );
  const offMin = (asUTC - probe.getTime()) / 60000;
  const offH = -offMin / 60;
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + offH * 3600000);
}

/**
 * Create a timed block event for a date and time range (business TZ). Used for blocked/time_range overrides.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} startTime - HH:MM or HH:MM:SS (local business day)
 * @param {string} endTime - HH:MM or HH:MM:SS (local business day)
 * @returns {{ eventId: string }}
 */
export async function createTimeRangeBlock(dateStr, startTime, endTime) {
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
  const calendar = await getCalendarClient();
  const parseMinutes = (t) => {
    const parts = (t || "").toString().trim().split(":");
    const h = parseInt(parts[0], 10) || 0;
    const min = parseInt(parts[1], 10) || 0;
    return h * 60 + min;
  };
  const dayStartUtc = getDayStartUtcForBusinessTZ(dateStr).getTime();
  const startUtc = new Date(dayStartUtc + parseMinutes(startTime) * 60000);
  const endUtc = new Date(dayStartUtc + parseMinutes(endTime) * 60000);
  const event = {
    summary: "Unavailable (blocked)",
    description: "Admin blocked this time range for availability.",
    start: { dateTime: startUtc.toISOString() },
    end: { dateTime: endUtc.toISOString() },
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
