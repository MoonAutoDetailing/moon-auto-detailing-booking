import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import getTravelMinutes from "./_routing/getTravelMinutes.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLOT_MINUTES = 10;
const MIN_BOOKABLE_GAP_MINUTES = 120;

const BUSINESS_RULES = {
  openHour: 8,
  closeHour: 18,
  allowedWeekdays: [1,2,3,4,5]
};

const BASE_ADDRESS = process.env.BASE_ADDRESS;

const BUSINESS_TZ = "America/New_York";

function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return (asUTC - date.getTime()) / 60000;
}

function getOffsetHoursForDay(dayStr) {
  // use noon UTC to avoid edge cases
  const probe = new Date(`${dayStr}T12:00:00Z`);
  const offMin = tzOffsetMinutes(probe, BUSINESS_TZ); // e.g. -300 in winter
  return -offMin / 60; // e.g. 5
}

function getDayStartUtcForBusinessTZ(dayStr) {
  const offH = getOffsetHoursForDay(dayStr);
  return new Date(Date.parse(`${dayStr}T00:00:00Z`) + offH * 3600000);
}

function getBusinessUtcHours(dayStr) {
  const offH = getOffsetHoursForDay(dayStr);
  return {
    openUtcHour: BUSINESS_RULES.openHour + offH,
    closeUtcHour: BUSINESS_RULES.closeHour + offH,
    offsetHours: offH
  };
}


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function fetchCalendarBlocks(dayDate, openUtcHour, closeUtcHour) {
  const dayStart = new Date(dayDate);  
  const dayEnd = addMinutes(dayStart, 1440);

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

  const resp = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 2500,
  });

  const items = resp.data.items || [];

  return items
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      if (e.start?.dateTime && e.end?.dateTime) {
        return {
          start: new Date(e.start.dateTime),
          end: new Date(e.end.dateTime)
        };
      }

      if (e.start?.date && e.end?.date) {
        const d = new Date(e.start.date);
        const allDayStart = new Date(d);
allDayStart.setUTCHours(openUtcHour, 0, 0, 0);

const allDayEnd = new Date(d);
allDayEnd.setUTCHours(closeUtcHour, 0, 0, 0);

return { start: allDayStart, end: allDayEnd };

      }

      return null;
    })
    .filter(Boolean);
}

// --------------------
// Helper utilities
// --------------------
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function roundUpToSlot(date) {
  const ms = date.getTime();
  const slotMs = SLOT_MINUTES * 60000;
  return new Date(Math.ceil(ms / slotMs) * slotMs);
}

function generateSlotsForDay(dayDate, openUtcHour, closeUtcHour) {
  const start = new Date(dayDate);
  start.setUTCHours(openUtcHour, 0, 0, 0);

  const end = new Date(dayDate);
  end.setUTCHours(closeUtcHour, 0, 0, 0);

  const slots = [];
  for (let t = new Date(start); t < end; t = addMinutes(t, SLOT_MINUTES)) {
    slots.push(new Date(t));
  }
  return slots;
}

function expandBlocksToRanges(blocks) {
  return (blocks || []).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end)
  }));
}

function normalizeBlocksToBusinessHours(dayDate, blocks, openUtcHour, closeUtcHour) {
  const open = new Date(dayDate);
  open.setUTCHours(openUtcHour, 0, 0, 0);

  const close = new Date(dayDate);
  close.setUTCHours(closeUtcHour, 0, 0, 0);

  const clipped = (blocks || [])
    .map(b => {
      const s = new Date(b.start);
      const e = new Date(b.end);

      // discard invalid
      if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return null;

      // clamp to business hours
      const start = new Date(Math.max(s.getTime(), open.getTime()));
      const end = new Date(Math.min(e.getTime(), close.getTime()));

      // discard if outside or zero-length after clamp
      if (end <= start) return null;
      return { start, end };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  // merge overlaps/adjacent
  const merged = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(b);
      continue;
    }
    if (b.start <= last.end) {
      // overlap/adjacent
      last.end = new Date(Math.max(last.end.getTime(), b.end.getTime()));
    } else {
      merged.push(b);
    }
  }

  return merged;
}


function getBusinessCloseDate(dayDate, closeUtcHour) {
  const d = new Date(dayDate);
  d.setUTCHours(closeUtcHour, 0, 0, 0);
  return d;
}

function getOpenDayAnchors(dayDate, serviceDurationMinutes, openUtcHour, closeUtcHour) {
  const anchors = [];

  const base = new Date(dayDate);
  base.setUTCHours(openUtcHour, 0, 0, 0);

  const increments = [0, 150, 300, 450];
  const businessClose = getBusinessCloseDate(dayDate, closeUtcHour);

  for (const offset of increments) {
    const start = addMinutes(base, offset);
    const serviceEnd = addMinutes(start, serviceDurationMinutes);

    if (serviceEnd <= businessClose) {
      anchors.push(start);
    }
  }

  return anchors;
}

function runExposureLogic(validTimes, dayDate, serviceDurationMinutes, expandedBlocks, openUtcHour, closeUtcHour) {
  if (!validTimes.length) return [];

  const hasBlockOnThisDay = expandedBlocks.some(b => {
    const blockDay = new Date(b.start);
    return blockDay.toDateString() === dayDate.toDateString();
  });

  if (!hasBlockOnThisDay) {
    return getOpenDayAnchors(dayDate, serviceDurationMinutes, openUtcHour, closeUtcHour);
  }

  const gaps = [];
  let currentGap = [validTimes[0]];

  for (let i = 1; i < validTimes.length; i++) {
    const prev = validTimes[i - 1];
    const curr = validTimes[i];
    const diffMinutes = (curr - prev) / 60000;

    if (diffMinutes === SLOT_MINUTES) currentGap.push(curr);
    else {
      gaps.push(currentGap);
      currentGap = [curr];
    }
  }
  gaps.push(currentGap);

  const exposed = [];
  const businessClose = getBusinessCloseDate(dayDate, closeUtcHour);

  for (const gap of gaps) {
    const gapStart = gap[0];
    let gapEnd = businessClose;

    for (const b of expandedBlocks) {
      if (b.start > gapStart && b.start < gapEnd) {
        gapEnd = b.start;
      }
    }

    exposed.push(gapStart);

    const gapLengthMinutes = (gapEnd - gapStart) / 60000;

    if (gapLengthMinutes > 240 && gap.length > 1) {
      const midpoint = gapStart.getTime() + (gapLengthMinutes / 2) * 60000;

      let closest = null;
      let smallestDiff = Infinity;

      for (const t of gap) {
        const diff = Math.abs(t.getTime() - midpoint);
        if (diff < smallestDiff) {
          smallestDiff = diff;
          closest = t;
        }
      }

      if (closest && closest.getTime() !== gapStart.getTime()) {
        exposed.push(closest);
      }
    }
  }

  return exposed;
}

function passesFragmentRule(start, serviceDurationMinutes, expandedBlocks, dayDate, openUtcHour, closeUtcHour) {
  const businessOpen = new Date(dayDate);
  businessOpen.setUTCHours(openUtcHour, 0, 0, 0);

  const serviceClose = new Date(dayDate);
  serviceClose.setUTCHours(closeUtcHour, 0, 0, 0);

  const serviceEnd = addMinutes(start, serviceDurationMinutes);

  if (serviceEnd > serviceClose) {
    return false;
  }

  let previousBoundary = businessOpen;

  for (const b of expandedBlocks) {
    if (b.end <= start && b.end > previousBoundary) {
      previousBoundary = b.end;
    }
  }

  let nextBoundary = serviceClose;

  for (const b of expandedBlocks) {
    if (b.start >= start && b.start < nextBoundary) {
      nextBoundary = b.start;
    }
  }

  const gapBefore = (start - previousBoundary) / 60000;
  const gapAfter = (nextBoundary - serviceEnd) / 60000;

  const isStartOfDay = previousBoundary.getTime() === businessOpen.getTime();

  if (!isStartOfDay && gapBefore > 0 && gapBefore < MIN_BOOKABLE_GAP_MINUTES) {
    return false;
  }

  const isEndOfDay = nextBoundary.getTime() === serviceClose.getTime();

  if (!isEndOfDay && gapAfter > 0 && gapAfter < MIN_BOOKABLE_GAP_MINUTES) {
    return false;
  }

  return true;
}

// --------------------
// Fetch bookings
// --------------------
async function fetchBookings(timeMin, timeMax) {
  const { data } = await supabase
    .from("bookings")
    .select("scheduled_start, scheduled_end, service_address, status")
    .in("status", ["confirmed","pending"])
    .gte("scheduled_start", timeMin)
    .lte("scheduled_start", timeMax);

  return data || [];
}

function pairKey(originAddress, destAddress) {
  return `${originAddress}||${destAddress}`;
}

async function precomputeTravelGraph(bookings, candidateAddress, memoryCache) {
  const travelGraph = new Map();
  const addressPairs = new Set();

  addressPairs.add(pairKey(BASE_ADDRESS, candidateAddress));
  addressPairs.add(pairKey(candidateAddress, BASE_ADDRESS));

  for (const booking of bookings) {
    addressPairs.add(pairKey(BASE_ADDRESS, booking.service_address));
    addressPairs.add(pairKey(booking.service_address, BASE_ADDRESS));
    addressPairs.add(pairKey(booking.service_address, candidateAddress));
    addressPairs.add(pairKey(candidateAddress, booking.service_address));
  }

  for (let i = 0; i < bookings.length - 1; i++) {
    const currentAddress = bookings[i].service_address;
    const nextAddress = bookings[i + 1].service_address;
    addressPairs.add(pairKey(currentAddress, nextAddress));
    addressPairs.add(pairKey(nextAddress, currentAddress));
  }

  await Promise.all(
    Array.from(addressPairs).map(async (key) => {
      const [originAddress, destAddress] = key.split("||");
      const minutes = await getTravelMinutes(originAddress, destAddress, memoryCache);
      travelGraph.set(key, minutes);
    })
  );

  return travelGraph;
}

// --------------------
// Dynamic travel gate
// --------------------
function passesTravelGate(start, end, prev, next, candidateAddress, travelGraph, dayDate, openUtcHour) {
  // --------------------------------------------------
  // CASE 1 — FIRST JOB OF DAY (home → candidate)
  // --------------------------------------------------
  if (!prev) {
    const minsFromHome = travelGraph.get(pairKey(BASE_ADDRESS, candidateAddress));

    const dayStart = new Date(dayDate);
dayStart.setUTCHours(openUtcHour, 0, 0, 0);

    if (addMinutes(dayStart, minsFromHome) > start) return false;
  }

  // --------------------------------------------------
  // CASE 2 — BETWEEN JOBS (prev job → candidate)
  // --------------------------------------------------
  if (prev) {
    const prevEnd = new Date(prev.scheduled_end);
    const minsFromPrev = travelGraph.get(pairKey(prev.service_address, candidateAddress));

    if (addMinutes(prevEnd, minsFromPrev) > start) return false;
  }

  // --------------------------------------------------
  // CASE 3 — BETWEEN JOBS (candidate → next job)
  // --------------------------------------------------
  if (next) {
    const nextStart = new Date(next.scheduled_start);
    const minsToNext = travelGraph.get(pairKey(candidateAddress, next.service_address));

    if (addMinutes(end, minsToNext) > nextStart) return false;
  }

  return true;
}


function getPrevBooking(bookingsByEnd, start) {
  if (!bookingsByEnd || !bookingsByEnd.length) return null;
  const t = start.getTime();
  let lo = 0;
  let hi = bookingsByEnd.length - 1;
  let ans = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midEnd = new Date(bookingsByEnd[mid].scheduled_end).getTime();
    if (midEnd <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return ans >= 0 ? bookingsByEnd[ans] : null;
}

function getNextBooking(bookingsByStart, end) {
  if (!bookingsByStart || !bookingsByStart.length) return null;
  const t = end.getTime();
  let lo = 0;
  let hi = bookingsByStart.length - 1;
  let ans = bookingsByStart.length;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midStart = new Date(bookingsByStart[mid].scheduled_start).getTime();
    if (midStart >= t) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return ans < bookingsByStart.length ? bookingsByStart[ans] : null;
}


// --------------------
// Main handler
// --------------------
export default async function handler(req, res) {
  try {
    const { day, duration_minutes, service_address } = req.query;
    console.log("API received address:", service_address);

const candidateAddress =
  service_address && service_address.trim().length > 5
    ? service_address
    : BASE_ADDRESS;
    console.log("Candidate address used for travel:", candidateAddress);


    const { openUtcHour, closeUtcHour } = getBusinessUtcHours(day);
const dayDate = getDayStartUtcForBusinessTZ(day); // NY midnight expressed as a UTC Date

    const [yy, mm, dd] = day.split("-").map(Number);
const weekday = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
if (!BUSINESS_RULES.allowedWeekdays.includes(weekday)) {
      return res.json({ slots: [] });
    }

    const bookings = await fetchBookings(
      dayDate.toISOString(),
      addMinutes(dayDate, 1440).toISOString()
    );

    const bookingsByStart = [...bookings].sort(
      (a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start)
    );
    const bookingsByEnd = [...bookings].sort(
      (a, b) => new Date(a.scheduled_end) - new Date(b.scheduled_end)
    );

    const memoryCache = {
      geocodeCache: new Map(),
      routeCache: new Map()
    };
    const travelGraph = await precomputeTravelGraph(bookingsByStart, candidateAddress, memoryCache);
    console.log("Travel graph size:", travelGraph.size);

    // --------------------
// Fetch REAL Google Calendar blocks (source of truth)
const calendarBlocks = await fetchCalendarBlocks(dayDate, openUtcHour, closeUtcHour);
const calendarRanges = expandBlocksToRanges(calendarBlocks);

// Pending bookings (Supabase) must behave like fixed blocks for shaping rules
const bookingRanges = bookingsByStart
  .filter(b => b.status === "pending")
  .map(b => ({
    start: new Date(b.scheduled_start),
    end: new Date(b.scheduled_end)
  }));


const expandedBlocksRaw = [...calendarRanges, ...bookingRanges];
const expandedBlocks = normalizeBlocksToBusinessHours(dayDate, expandedBlocksRaw, openUtcHour, closeUtcHour);

    const slots = generateSlotsForDay(dayDate, openUtcHour, closeUtcHour);
    const valid = [];
    const serviceDurationMinutes = Number(duration_minutes);

    for (const start of slots) {
      const end = addMinutes(start, serviceDurationMinutes);

      const overlapsCalendarBlock = expandedBlocks.some(b =>
        intervalsOverlap(start, end, b.start, b.end)
      );
      if (overlapsCalendarBlock) continue;

      if (!passesFragmentRule(start, serviceDurationMinutes, expandedBlocks, dayDate, openUtcHour, closeUtcHour)) continue;

      valid.push(start);
    }

    // 1) Apply TRAVEL FILTER to the full valid set (so green blocks can "shift")
const validAfterTravel = valid.filter((start) => {
  const end = addMinutes(start, serviceDurationMinutes);
  const prev = getPrevBooking(bookingsByEnd, start);
  const next = getNextBooking(bookingsByStart, end);

  const allowed = passesTravelGate(
  start,
  end,
  prev,
  next,
  candidateAddress,
  travelGraph,
  dayDate,
  openUtcHour
);

  if (!allowed) {
    console.log("VALID slot removed by travel:", start.toISOString(), {
      prevEnd: prev?.scheduled_end,
      nextStart: next?.scheduled_start,
      candidateAddress
    });
  }

  return allowed;
});

// 2) Now run your shaping engine on the travel-valid set
const shaped = runExposureLogic(
  validAfterTravel,
  dayDate,
  serviceDurationMinutes,
  expandedBlocks,
  openUtcHour,
  closeUtcHour
);

const exposed = shaped.map((start) => start.toISOString());

// IMPORTANT: log BEFORE responding (your current log is after res.json)
console.log("DEBUG SERVER FINAL SLOTS", {
  day,
  service_address: candidateAddress,
  count: exposed.length,
  slots: exposed
});

return res.json({ slots: exposed });


  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "availability_failed" });
  }
}
