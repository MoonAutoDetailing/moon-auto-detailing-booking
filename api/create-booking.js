import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { rateLimit } from "./_rateLimit.js";
import { checkAvailability } from "./_availability.js";
import getTravelMinutes from "./_routing/getTravelMinutes.js";
import { sendBookingCreatedEmailCore } from "../lib/email/sendBookingCreatedEmail.js";
import { getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";

const BASE_ADDRESS = process.env.BASE_ADDRESS;
const BUSINESS_TZ = "America/New_York";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

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
  const probe = new Date(`${dayStr}T12:00:00Z`);
  return -tzOffsetMinutes(probe, BUSINESS_TZ) / 60;
}

function getDayStartUtcForBusinessTZ(dayStr) {
  const offH = getOffsetHoursForDay(dayStr);
  return new Date(Date.parse(`${dayStr}T00:00:00Z`) + offH * 3600000);
}

function getBusinessUtcHours(dayStr) {
  const offH = getOffsetHoursForDay(dayStr);
  return {
    openUtcHour: 8 + offH,
    closeUtcHour: 18 + offH
  };
}

async function fetchCalendarBlocksForDay(dayDate, openUtcHour, closeUtcHour) {
  const dayEnd = addMinutes(dayDate, 1440);
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
  const saJson = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const creds = JSON.parse(Buffer.from(saJson, "base64").toString("utf-8"));
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
  });
  const calendar = google.calendar({ version: "v3", auth });
  const resp = await calendar.events.list({
    calendarId,
    timeMin: dayDate.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 2500
  });
  const items = resp.data.items || [];
  return items
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      if (e.start?.dateTime && e.end?.dateTime) {
        return { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime), location: (e.location || "").trim() };
      }
      if (e.start?.date && e.end?.date) {
        const d = new Date(dayDate);
        d.setUTCHours(openUtcHour, 0, 0, 0);
        const end = new Date(dayDate);
        end.setUTCHours(closeUtcHour, 0, 0, 0);
        return { start: d, end, location: (e.location || "").trim() };
      }
      return null;
    })
    .filter(Boolean);
}

function getPrevBooking(bookingsByEnd, start) {
  if (!bookingsByEnd || !bookingsByEnd.length) return null;
  const t = start.getTime();
  let lo = 0, hi = bookingsByEnd.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midEnd = new Date(bookingsByEnd[mid].scheduled_end).getTime();
    if (midEnd <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans >= 0 ? bookingsByEnd[ans] : null;
}

function travelFeeFromMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 20) return 0;
  if (m <= 30) return 20;
  if (m <= 40) return 30;
  if (m <= 60) return 50;
  return 50;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const rl = rateLimit(req, {
    key: "create-booking",
    limit: 5,
    windowMs: 15 * 60 * 1000
  });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({
      ok: false,
      message: "Too many booking attempts. Please try again in a few minutes."
    });
  }

  try {
    const body = req.body || {};
    const {
      customer_id,
      vehicle_id,
      scheduled_start,
      scheduled_end,
      service_address,
      service_variant_id
    } = body;

    if (!customer_id || !vehicle_id || !scheduled_start || !scheduled_end || !service_address || !service_variant_id) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: customer_id, vehicle_id, scheduled_start, scheduled_end, service_address, service_variant_id"
      });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const isAvailable = await checkAvailability(scheduled_start, scheduled_end);
    if (!isAvailable) {
      return res.status(409).json({
        ok: false,
        message: "Time slot no longer available."
      });
    }

    const { data: variantRow } = await supabase
      .from("service_variants")
      .select("price, vehicle_size")
      .eq("id", service_variant_id)
      .single();
    if (!variantRow || variantRow.price == null) {
      return res.status(400).json({ ok: false, message: "Invalid service variant." });
    }
    let base_price = Number(variantRow.price);
    if (req.body.subscription_mode === true) {
      const { data: subPrice } = await supabase
        .from("subscription_prices")
        .select("price")
        .eq("service_category", req.body.subscription_category)
        .eq("frequency", req.body.subscription_frequency)
        .eq("vehicle_size", variantRow.vehicle_size)
        .single();
      if (subPrice) {
        base_price = subPrice.price;
      }
    }

    const dayStr = scheduled_start.slice(0, 10);
    const dayDate = getDayStartUtcForBusinessTZ(dayStr);
    const dayEnd = addMinutes(dayDate, 1440);
    const { openUtcHour, closeUtcHour } = getBusinessUtcHours(dayStr);

    const { data: dayBookings } = await supabase
      .from("bookings")
      .select("scheduled_start, scheduled_end, service_address, status")
      .in("status", ["confirmed", "pending", "completed"])
      .gte("scheduled_start", dayDate.toISOString())
      .lte("scheduled_start", dayEnd.toISOString());
    const blockingBookings = (dayBookings || []).filter(b => ["confirmed", "pending", "completed"].includes(b.status));

    const calendarBlocks = await fetchCalendarBlocksForDay(dayDate, openUtcHour, closeUtcHour);
    const calendarAsBookings = calendarBlocks.map(b => ({
      scheduled_start: b.start.toISOString(),
      scheduled_end: b.end.toISOString(),
      service_address: (b.location && b.location.trim().length > 5) ? b.location.trim() : (BASE_ADDRESS || "")
    }));
    const travelBookings = [...blockingBookings, ...calendarAsBookings].sort(
      (a, b) => new Date(a.scheduled_end) - new Date(b.scheduled_end)
    );
    const bookingStart = new Date(scheduled_start);
    const prev = getPrevBooking(travelBookings, bookingStart);
    const origin = prev ? (prev.service_address || "").trim() : (BASE_ADDRESS || "");
    const serviceAddressTrim = (service_address || "").trim();

    const memoryCache = { geocodeCache: new Map(), routeCache: new Map() };
    let travel_minutes;
    try {
      travel_minutes = await getTravelMinutes(origin || BASE_ADDRESS, serviceAddressTrim, memoryCache, { strict: true });
    } catch (routingErr) {
      return res.status(400).json({
        ok: false,
        message: "We couldn't verify travel time for this address. Please double-check the address or try again."
      });
    }
    if (travel_minutes > 60) {
      return res.status(409).json({
        ok: false,
        message: "This address is outside our service radius for that time."
      });
    }
    const travel_fee = travelFeeFromMinutes(travel_minutes);
    const total_price = base_price + travel_fee;

    const manage_token = crypto.randomUUID();
    const { data: booking, error: insertErr } = await supabase
      .from("bookings")
      .insert({
        customer_id,
        vehicle_id,
        service_variant_id,
        service_address,
        scheduled_start,
        scheduled_end,
        status: "pending",
        manage_token,
        travel_minutes,
        travel_fee,
        base_price,
        total_price
      })
      .select("id, manage_token")
      .single();

    if (insertErr) {
      if (insertErr.code === "23P01" || (insertErr.message || "").includes("bookings_no_overlap")) {
        return res.status(409).json({ ok: false, message: "Time slot no longer available." });
      }
      console.error("[create-booking] insert error", insertErr);
      return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
    }

    if (!booking) {
      return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
    }

    const subscriptionId = body.subscription_id;
    if (subscriptionId) {
      const { data: subscription } = await supabase
        .from("subscriptions")
        .select("id, status")
        .eq("id", subscriptionId)
        .single();
      if (!subscription || subscription.status !== "active") {
        return res.status(400).json({ ok: false, message: "Invalid or inactive subscription." });
      }
      const { data: cycle } = await supabase
        .from("subscription_cycles")
        .select("id, window_start_date, window_end_date, pushback_used, pushback_end_date")
        .eq("subscription_id", subscriptionId)
        .in("status", ["open"])
        .limit(1)
        .maybeSingle();
      if (!cycle) {
        return res.status(400).json({ ok: false, message: "No open subscription window for this cycle." });
      }
      const bookingDate = scheduled_start.slice(0, 10);
      const windowEnd = getEffectiveWindowEnd(cycle);
      const inMainWindow = bookingDate >= cycle.window_start_date && bookingDate <= (cycle.window_end_date || "");
      const inPushback = cycle.pushback_used && cycle.pushback_end_date
        && bookingDate >= cycle.window_end_date && bookingDate <= cycle.pushback_end_date;
      if (!inMainWindow && !inPushback) {
        return res.status(400).json({ ok: false, message: "Booking date is outside this subscription window." });
      }
      const { data: existingLink } = await supabase
        .from("subscription_cycle_bookings")
        .select("id")
        .eq("cycle_id", cycle.id)
        .limit(1)
        .maybeSingle();
      if (existingLink) {
        return res.status(409).json({ ok: false, message: "This subscription cycle already has a booking." });
      }
      const { error: linkErr } = await supabase
        .from("subscription_cycle_bookings")
        .insert({ cycle_id: cycle.id, booking_id: booking.id });
      if (linkErr) {
        console.error("[create-booking] subscription_cycle_bookings insert", linkErr);
        return res.status(500).json({ ok: false, message: "Failed to attach booking to subscription cycle." });
      }
      const { error: cycleUpdateErr } = await supabase
        .from("subscription_cycles")
        .update({ status: "booked" })
        .eq("id", cycle.id);
      if (cycleUpdateErr) {
        console.error("[create-booking] cycle status update", cycleUpdateErr);
      }
      console.log("CYCLE_BOOKED", { cycle_id: cycle.id, booking_id: booking.id });
    }

    try {
      await sendBookingCreatedEmailCore(booking.id);
    } catch (emailErr) {
      console.error("[EMAIL] type=booking-created booking_id=" + booking.id + " error", emailErr);
    }

    return res.status(200).json({
      ok: true,
      bookingId: booking.id,
      manage_token: booking.manage_token
    });
  } catch (err) {
    console.error("create-booking error:", err);
    return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
  }
}
