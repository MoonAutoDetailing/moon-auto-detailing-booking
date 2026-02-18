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

// --------------------
// Dynamic travel gate
// --------------------
async function passesTravelGate(start, end, bookings) {
  const prev = bookings
    .filter(b => new Date(b.scheduled_end) <= start)
    .sort((a,b)=> new Date(b.scheduled_end)-new Date(a.scheduled_end))[0];

  const next = bookings
    .filter(b => new Date(b.scheduled_start) >= end)
    .sort((a,b)=> new Date(a.scheduled_start)-new Date(b.scheduled_start))[0];

  // ⭐ FIRST BOOKING OF DAY — ALWAYS ALLOW
  if (!prev && !next) return true;

  // 1️⃣ Travel from previous booking → candidate
  if (prev) {
    const prevEnd = new Date(prev.scheduled_end);
    const travelFromPrev = await getTravelMinutes(prev.service_address, BASE_ADDRESS);

    if (start < addMinutes(prevEnd, travelFromPrev)) {
      return false;
    }
  }

  // 2️⃣ Travel from candidate → next booking
  if (next) {
    const nextStart = new Date(next.scheduled_start);
    const travelToNext = await getTravelMinutes(BASE_ADDRESS, next.service_address);

    if (addMinutes(end, travelToNext) > nextStart) {
      return false;
    }
  }

  // 3️⃣ Must be able to return home before close of business
  const close = new Date(start);
  close.setHours(BUSINESS_RULES.closeHour,0,0,0);

  const travelHome = await getTravelMinutes(BASE_ADDRESS, BASE_ADDRESS);
  if (addMinutes(end, travelHome) > close) {
    return false;
  }

  return true;
}


// --------------------
// Main handler
// --------------------
export default async function handler(req, res) {
  try {
    const { day, duration_minutes } = req.query;

    const dayDate = new Date(day);
    if (!BUSINESS_RULES.allowedWeekdays.includes(dayDate.getDay())) {
      return res.json({ slots: [] });
    }

    const bookings = await fetchBookings(
      dayDate.toISOString(),
      addMinutes(dayDate, 1440).toISOString()
    );

    const slots = generateSlotsForDay(dayDate);
    const valid = [];

    for (const start of slots) {
      const end = addMinutes(start, Number(duration_minutes));

      const overlap = bookings.some(b =>
        intervalsOverlap(start, end, new Date(b.scheduled_start), new Date(b.scheduled_end))
      );

      if (overlap) continue;

      const travelOK = await passesTravelGate(start, end, bookings);
      if (!travelOK) continue;

      valid.push(start.toISOString());
    }

    res.json({ slots: valid });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "availability_failed" });
  }
}
