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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
      return res.status(400).json({ error: "Invalid override_date (use YYYY-MM-DD)" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: row, error: fetchErr } = await supabase
      .from("availability_overrides")
      .select("id, google_event_id")
      .eq("override_date", overrideDate)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!row) {
      return res.status(200).json({ cleared: false, message: "No override for this date" });
    }

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
    return res.status(200).json({ cleared: true });
  } catch (err) {
    console.error("admin-availability-clear", err);
    return res.status(500).json({ error: err.message || "Clear failed" });
  }
}
