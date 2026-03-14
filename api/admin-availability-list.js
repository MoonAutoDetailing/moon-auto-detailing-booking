import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { getOverridesForRange } from "./_availabilityOverrides.js";

const BUSINESS_RULES = { allowedWeekdays: [1, 2, 3, 4, 5] };

function firstDayOfMonth(y, m) {
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function lastDayOfMonth(y, m) {
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-availability-list: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const year = parseInt(url.searchParams.get("year"), 10);
    const month = parseInt(url.searchParams.get("month"), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year or month" });
    }

    const startDate = firstDayOfMonth(year, month);
    const endDate = lastDayOfMonth(year, month);

    const overrides = await getOverridesForRange(startDate, endDate);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: bookings } = await supabase
      .from("bookings")
      .select("scheduled_start, status")
      .in("status", ["confirmed", "pending", "completed"])
      .gte("scheduled_start", startDate + "T00:00:00.000Z")
      .lte("scheduled_start", endDate + "T23:59:59.999Z");

    const bookingCountByDate = {};
    for (const b of bookings || []) {
      const d = b.scheduled_start.slice(0, 10);
      bookingCountByDate[d] = (bookingCountByDate[d] || 0) + 1;
    }

    const overrideMap = {};
    for (const o of overrides) {
      overrideMap[o.override_date] = o;
    }

    return res.status(200).json({
      overrides,
      overrideMap,
      bookingCountByDate,
      startDate,
      endDate,
      allowedWeekdays: BUSINESS_RULES.allowedWeekdays,
    });
  } catch (err) {
    console.error("admin-availability-list", err);
    return res.status(500).json({ error: err.message || "List failed" });
  }
}
