import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import verifyAdmin from "./_verifyAdmin.js";
import { sendRescheduleLinkEmailCore } from "../lib/email/sendRescheduleLinkEmail.js";



export default async function handler(req, res) {
    if (!verifyAdmin(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ ok: false, message: "Missing bookingId" });
    }

    // 2️⃣ Supabase (service role)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: booking, error } = await supabase
  .from("bookings")
  .select(`
    google_event_id,
    manage_token,
    customers (
      full_name,
      email
    )
  `)
  .eq("id", bookingId)
  .single();


    if (error || !booking) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    if (!booking.google_event_id) {
      return res.status(400).json({
        ok: false,
        message: "No google_event_id stored for this booking"
      });
    }

    // 4️⃣ Google Auth
    const decoded = Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      "base64"
    ).toString("utf-8");

    const creds = JSON.parse(decoded);

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"]
    });

    const calendar = google.calendar({ version: "v3", auth });

    // 5️⃣ Delete Event (HARD FAILURE)
await calendar.events.delete({
  calendarId: process.env.GOOGLE_CALENDAR_ID.trim(),
  eventId: booking.google_event_id
});

      // Clear Google event fields only (utility behavior)
const { error: clearError } = await supabase
  .from("bookings")
  .update({
    google_event_id: null,
    google_event_html_link: null
  })
  .eq("id", bookingId);

if (clearError) {
  console.error("Failed clearing Google fields:", clearError);
  return res.status(500).json({ ok: false, message: "Failed clearing Google fields" });
}
      // Send reschedule email (fire-and-forget)
try {
  await sendRescheduleLinkEmailCore({
    email: booking.customers.email,
    fullName: booking.customers.full_name,
    manageToken: booking.manage_token
  });
} catch (err) {
  console.error("Reschedule email failed:", err);
}


return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("DELETE CALENDAR ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Calendar deletion failed"
    });
  }
}
