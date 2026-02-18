import { createClient } from "@supabase/supabase-js";
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

function generateSlotsForDay(dayDate) {
  const start = new Date(dayDate);
  start.setHours(BUSINESS_RULES.openHour,0,0,0);

  const end = new Date(dayDate);
  end.setHours(BUSINESS_RULES.closeHour,0,0,0);

  const slots = [];
  for (let t = new Date(start); t < end; t = addMinutes(t, SLOT_MINUTES)) {
    slots.push(new Date(t));
  }
  return slots;
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
function passesTravelGate(start, end, prev, next, candidateAddress, travelGraph) {
  // --------------------------------------------------
  // CASE 1 — FIRST JOB OF DAY (home → candidate)
  // --------------------------------------------------
  if (!prev) {
    const minsFromHome = travelGraph.get(pairKey(BASE_ADDRESS, candidateAddress));

    const dayStart = new Date(start);
    dayStart.setHours(BUSINESS_RULES.openHour,0,0,0);

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

  // --------------------------------------------------
  // CASE 4 — LAST JOB OF DAY (candidate → home)
  // --------------------------------------------------
  if (!next) {
    const minsToHome = travelGraph.get(pairKey(candidateAddress, BASE_ADDRESS));

    const close = new Date(start);
    close.setHours(BUSINESS_RULES.closeHour,0,0,0);

    if (addMinutes(end, minsToHome) > close) return false;
  }

  return true;
}



// --------------------
// Main handler
// --------------------
export default async function handler(req, res) {
  try {
    const { day, duration_minutes, service_address } = req.query;

const candidateAddress =
  service_address && service_address.trim().length > 5
    ? service_address
    : BASE_ADDRESS;


    const dayDate = new Date(day);
    if (!BUSINESS_RULES.allowedWeekdays.includes(dayDate.getDay())) {
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

    const slots = generateSlotsForDay(dayDate);
    const valid = [];

    let prevPointer = -1;
    let nextPointer = 0;

    for (const start of slots) {
      const end = addMinutes(start, Number(duration_minutes));

      while (
        prevPointer + 1 < bookingsByEnd.length &&
        new Date(bookingsByEnd[prevPointer + 1].scheduled_end) <= start
      ) {
        prevPointer++;
      }

      while (
        nextPointer < bookingsByStart.length &&
        new Date(bookingsByStart[nextPointer].scheduled_start) < end
      ) {
        nextPointer++;
      }

      const overlap = bookingsByStart.some(b =>
        intervalsOverlap(start, end, new Date(b.scheduled_start), new Date(b.scheduled_end))
      );

      if (overlap) continue;

      const prev = prevPointer >= 0 ? bookingsByEnd[prevPointer] : null;
      const next = nextPointer < bookingsByStart.length ? bookingsByStart[nextPointer] : null;
      const travelOK = passesTravelGate(start, end, prev, next, candidateAddress, travelGraph);
      if (!travelOK) continue;

      valid.push(start.toISOString());
    }

    res.json({ slots: valid });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "availability_failed" });
  }
}
