import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { createAllDayBlock, createTimeRangeBlock, deleteCalendarEvent } from "./_adminCalendar.js";

function parseTimeToMinutes(t) {
  const s = (t || "").toString().trim();
  const parts = s.split(":");
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-availability-upsert: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const overrideDate = (body.override_date || body.overrideDate || "").toString().trim();
    const mode = (body.mode || "").toString().toLowerCase();
    const scope = (body.scope || "full_day").toString().toLowerCase();
    const startTime = body.start_time != null ? body.start_time.toString().trim() : null;
    const endTime = body.end_time != null ? body.end_time.toString().trim() : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
      return res.status(400).json({ error: "Invalid override_date (use YYYY-MM-DD)" });
    }
    if (mode !== "open" && mode !== "blocked") {
      return res.status(400).json({ error: "mode must be 'open' or 'blocked'" });
    }
    if (scope !== "full_day" && scope !== "time_range") {
      return res.status(400).json({ error: "scope must be 'full_day' or 'time_range'" });
    }

    if (scope === "full_day") {
      if (startTime != null || endTime != null) {
        return res.status(400).json({ error: "full_day scope must not have start_time or end_time" });
      }
    } else {
      if (!startTime || !endTime) {
        return res.status(400).json({ error: "time_range scope requires start_time and end_time" });
      }
      const startMin = parseTimeToMinutes(startTime);
      const endMin = parseTimeToMinutes(endTime);
      if (startMin >= endMin) {
        return res.status(400).json({ error: "start_time must be before end_time" });
      }
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: existing } = await supabase
      .from("availability_overrides")
      .select("id, mode, scope, google_event_id")
      .eq("override_date", overrideDate)
      .maybeSingle();

    if (existing?.google_event_id) {
      try {
        await deleteCalendarEvent(existing.google_event_id);
      } catch (e) {
        console.warn("admin-availability-upsert: delete old Google event failed", e.message);
      }
    }

    let googleEventId = null;
    if (mode === "blocked") {
      if (scope === "full_day") {
        const { eventId } = await createAllDayBlock(overrideDate);
        googleEventId = eventId;
      } else {
        const { eventId } = await createTimeRangeBlock(overrideDate, startTime, endTime);
        googleEventId = eventId;
      }
    }

    const row = {
      override_date: overrideDate,
      mode,
      scope,
      start_time: scope === "time_range" ? startTime : null,
      end_time: scope === "time_range" ? endTime : null,
      reason: body.reason || null,
      google_event_id: googleEventId,
      updated_at: new Date().toISOString(),
    };

    const selectFields = "id, override_date, mode, scope, start_time, end_time, google_event_id, created_at, updated_at";

    if (existing) {
      const { error: updateErr } = await supabase
        .from("availability_overrides")
        .update(row)
        .eq("id", existing.id);
      if (updateErr) throw updateErr;
      return res.status(200).json({ override: { ...row, id: existing.id }, updated: true });
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("availability_overrides")
      .insert(row)
      .select(selectFields)
      .single();
    if (insertErr) throw insertErr;
    return res.status(200).json({ override: inserted, updated: false });
  } catch (err) {
    console.error("admin-availability-upsert", err);
    return res.status(500).json({ error: err.message || "Upsert failed" });
  }
}
