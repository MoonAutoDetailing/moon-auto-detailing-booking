import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { createAllDayBlock } from "./_adminCalendar.js";

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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
      return res.status(400).json({ error: "Invalid override_date (use YYYY-MM-DD)" });
    }
    if (mode !== "open" && mode !== "blocked") {
      return res.status(400).json({ error: "mode must be 'open' or 'blocked'" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: existing } = await supabase
      .from("availability_overrides")
      .select("id, mode, google_event_id")
      .eq("override_date", overrideDate)
      .eq("scope", "full_day")
      .maybeSingle();

    let googleEventId = null;
    if (mode === "blocked") {
      if (existing?.mode === "blocked" && existing?.google_event_id) {
        const { deleteCalendarEvent } = await import("./_adminCalendar.js");
        await deleteCalendarEvent(existing.google_event_id);
      }
      const { eventId } = await createAllDayBlock(overrideDate);
      googleEventId = eventId;
    } else if (existing?.mode === "blocked" && existing?.google_event_id) {
      const { deleteCalendarEvent } = await import("./_adminCalendar.js");
      await deleteCalendarEvent(existing.google_event_id);
    }

    const row = {
      override_date: overrideDate,
      mode,
      scope: "full_day",
      start_time: null,
      end_time: null,
      reason: body.reason || null,
      google_event_id: mode === "blocked" ? googleEventId : null,
      updated_at: new Date().toISOString(),
    };

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
      .select("id, override_date, mode, scope, google_event_id, created_at, updated_at")
      .single();
    if (insertErr) throw insertErr;
    return res.status(200).json({ override: inserted, updated: false });
  } catch (err) {
    console.error("admin-availability-upsert", err);
    return res.status(500).json({ error: err.message || "Upsert failed" });
  }
}
