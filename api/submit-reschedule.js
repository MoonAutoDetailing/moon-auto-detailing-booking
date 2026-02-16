import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { bookingId, start, end } = req.body;

    if (!bookingId || !start || !end) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Update booking time and reset lifecycle
    const { error } = await supabase
      .from("bookings")
      .update({
        scheduled_start: start,
        scheduled_end: end,
        status: "pending",
        google_event_id: null,
        google_event_html_link: null
      })
      .eq("id", bookingId);

    if (error) {
      console.error("Reschedule update failed:", error);
      return res.status(500).json({ error: "Failed to update booking" });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("submit-reschedule error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
