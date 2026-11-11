import { rateLimit } from "../_rateLimit.js";
import { requireRole, ROLES, serviceClient, sendAuthError, parseBody, verifySecret, ADMIN_ROLES } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { nyDayRange } from "../_jobs.js";
import { checkGeofence, validPosition, payWeek, summarizeWeek, clockSettings } from "../_timeclock.js";
import geocodeAddress from "../_routing/geocodeAddress.js";

const ENTRY_COLS = "id, clock_in_at, clock_out_at, verify_method, in_site, in_distance_m, notes";

/** Places a clock-in counts as "on site": today's job addresses and the base address. */
async function clockSites(sb, today) {
  const { startISO, endISO } = nyDayRange(today);
  const { data, error } = await sb
    .from("bookings")
    .select("service_address, customers:customer_id ( full_name )")
    .in("status", ["confirmed", "completed"])
    .gte("scheduled_start", startISO)
    .lt("scheduled_start", endISO);
  if (error) throw error;

  const wanted = (data || [])
    .filter((b) => b.service_address)
    .map((b) => ({ label: `${b.customers?.full_name || "Job"} — ${b.service_address}`, address: b.service_address }));
  if (process.env.BASE_ADDRESS) wanted.push({ label: "Base", address: process.env.BASE_ADDRESS });

  const cache = new Map();
  const sites = [];
  for (const w of wanted) {
    try {
      const { lat, lng } = await geocodeAddress(w.address, cache);
      sites.push({ label: w.label, lat, lng });
    } catch (err) {
      console.error("staff-clock: geocode failed", w.address, err?.message);
    }
  }
  return sites;
}

/** Finds the active owner/manager whose PIN this is. */
async function managerForPin(sb, pin) {
  if (!/^\d{4,6}$/.test(String(pin || ""))) return null;
  const { data, error } = await sb.from("staff").select("id, full_name, role, pin_hash").eq("active", true).in("role", ADMIN_ROLES);
  if (error) throw error;
  return (data || []).find((m) => m.pin_hash && verifySecret(String(pin), m.pin_hash)) || null;
}

async function status(sb, staffId) {
  const today = todayNY();
  const week = payWeek(today);
  const { data: entries, error } = await sb
    .from("time_entries")
    .select(ENTRY_COLS + ", voided_at")
    .eq("staff_id", staffId)
    .is("voided_at", null)
    .gte("clock_in_at", new Date(Date.parse(week.startISO) - 24 * 3600000).toISOString())
    .order("clock_in_at", { ascending: true });
  if (error) throw error;
  const { data: openRows, error: oErr } = await sb
    .from("time_entries")
    .select(ENTRY_COLS)
    .eq("staff_id", staffId)
    .is("clock_out_at", null)
    .is("voided_at", null)
    .limit(1);
  if (oErr) throw oErr;
  const dayStart = Date.parse(nyDayRange(today).startISO);
  const summary = summarizeWeek(entries || [], week);
  return {
    open_entry: openRows?.[0] || null,
    today_entries: (entries || []).filter((e) => !e.clock_out_at || Date.parse(e.clock_out_at) >= dayStart),
    week: { start: week.weekStart, end: week.weekEnd, hours: summary.hours, overtime_hours: summary.overtimeHours },
  };
}

/**
 * GET → { open_entry, today_entries, week }.
 * POST { action: "in", lat, lng, accuracy, pin? } → clock in (GPS near a job/base, or a
 *      manager PIN; responds 403 { needs_pin: true } when neither).
 * POST { action: "out", lat?, lng?, accuracy? } → clock out (location recorded, not required).
 */
export default async function handler(req, res) {
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") return res.status(200).json(await status(sb, staff.id));
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req);
    const position = validPosition(body) ? { lat: Number(body.lat), lng: Number(body.lng), accuracy: Number(body.accuracy) || null } : null;
    const now = new Date().toISOString();

    const { data: openRows, error: oErr } = await sb
      .from("time_entries")
      .select("id, clock_in_at")
      .eq("staff_id", staff.id)
      .is("clock_out_at", null)
      .is("voided_at", null)
      .limit(1);
    if (oErr) throw oErr;
    const open = openRows?.[0] || null;

    if (body.action === "in") {
      if (open) return res.status(409).json({ error: "You're already clocked in", ...(await status(sb, staff.id)) });

      const sites = await clockSites(sb, todayNY());
      const fence = position ? checkGeofence(position, sites) : { ok: false, nearest: null };
      let verify_method = null;
      let verified_by = null;

      if (fence.ok) {
        verify_method = "gps";
      } else if (body.pin) {
        const limit = rateLimit(req, { key: `clock-pin:${staff.id}`, limit: 5, windowMs: 15 * 60 * 1000 });
        if (!limit.allowed) return res.status(429).json({ error: "Too many PIN attempts. Wait a few minutes or call your manager." });
        const manager = await managerForPin(sb, body.pin);
        if (!manager) return res.status(403).json({ error: "That PIN didn't match a manager", needs_pin: true, nearest: fence.nearest });
        verify_method = "pin";
        verified_by = manager.id;
      } else {
        const where = !position
          ? "We couldn't get your location."
          : fence.nearest
            ? `You're about ${(fence.nearest.distanceM / 1609.34).toFixed(1)} mi from the nearest job site (${fence.nearest.label}).`
            : "There are no job sites set for today.";
        return res.status(403).json({
          error: `${where} Ask a manager to enter their PIN to approve this clock-in.`,
          needs_pin: true,
          nearest: fence.nearest,
          radius_m: clockSettings().radiusM,
        });
      }

      const { error: insErr } = await sb.from("time_entries").insert({
        staff_id: staff.id,
        clock_in_at: now,
        in_lat: position?.lat ?? null,
        in_lng: position?.lng ?? null,
        in_accuracy_m: position?.accuracy ?? null,
        in_distance_m: fence.nearest?.distanceM ?? null,
        in_site: fence.nearest?.label ?? null,
        verify_method,
        verified_by,
      });
      if (insErr) {
        if (insErr.code === "23505") return res.status(409).json({ error: "You're already clocked in" });
        throw insErr;
      }
      return res.status(200).json({ ok: true, verify_method, ...(await status(sb, staff.id)) });
    }

    if (body.action === "out") {
      if (!open) return res.status(409).json({ error: "You're not clocked in", ...(await status(sb, staff.id)) });
      let outDistance = null;
      if (position) {
        const sites = await clockSites(sb, todayNY());
        outDistance = checkGeofence(position, sites).nearest?.distanceM ?? null;
      }
      const { error: upErr } = await sb
        .from("time_entries")
        .update({
          clock_out_at: now,
          out_lat: position?.lat ?? null,
          out_lng: position?.lng ?? null,
          out_accuracy_m: position?.accuracy ?? null,
          out_distance_m: outDistance,
          updated_at: now,
        })
        .eq("id", open.id)
        .is("clock_out_at", null);
      if (upErr) throw upErr;
      return res.status(200).json({ ok: true, ...(await status(sb, staff.id)) });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("staff-clock error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
