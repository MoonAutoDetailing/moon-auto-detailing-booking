import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { deleteCalendarEvent } from "./_adminCalendar.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-availability-clear: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const overrideDate = (body.override_date || body.overrideDate || "").toString().trim();
    const overrideDates = Array.isArray(body.override_dates) ? body.override_dates.map((d) => (d || "").toString().trim()).filter(Boolean) : null;

    const dateList = overrideDates && overrideDates.length > 0 ? overrideDates : (overrideDate ? [overrideDate] : []);
    if (dateList.length === 0) {
      return res.status(400).json({ error: "Provide override_date or override_dates (array of YYYY-MM-DD)" });
    }
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const d of dateList) {
      if (!dateRegex.test(d)) {
        return res.status(400).json({ error: "Invalid date (use YYYY-MM-DD): " + d });
      }
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    let clearedCount = 0;
    for (const singleDate of dateList) {
      const { data: row, error: fetchErr } = await supabase
        .from("availability_overrides")
        .select("id, google_event_id")
        .eq("override_date", singleDate)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!row) continue;

      if (row.google_event_id) {
        try {
          await deleteCalendarEvent(row.google_event_id);
        } catch (e) {
          console.warn("admin-availability-clear: Google event delete failed", e.message);
        }
      }

      const { error: deleteErr } = await supabase
        .from("availability_overrides")
        .delete()
        .eq("id", row.id);

      if (deleteErr) throw deleteErr;
      clearedCount++;
    }

    if (dateList.length === 1) {
      return res.status(200).json({ cleared: clearedCount > 0, message: clearedCount > 0 ? undefined : "No override for this date" });
    }
    return res.status(200).json({ cleared: clearedCount });
  } catch (err) {
    console.error("admin-availability-clear", err);
    return res.status(500).json({ error: err.message || "Clear failed" });
  }
}
