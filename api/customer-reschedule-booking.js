import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { sendRescheduleLinkEmailCore } from "../lib/email/sendRescheduleLinkEmail.js";


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Missing token" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // =========================
    // 1) Fetch booking
    // =========================
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, google_event_id, status")
      .eq("manage_token", token)
      .single();

    if (error || !booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.status === "reschedule_requested") {
  return res.status(200).json({
    message: "Reschedule already requested. Please check your email for the reschedule link."
  });
}

    // =========================
    // 2) Remove calendar event
    // =========================
    if (booking.google_event_id) {
      const decoded = Buffer.from(
        requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
        "base64"
      ).toString("utf-8");

      const creds = JSON.parse(decoded);

      const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/calendar"]
      });

      const calendar = google.calendar({ version: "v3", auth });

      try {
        await calendar.events.delete({
          calendarId: requireEnv("GOOGLE_CALENDAR_ID").trim(),
          eventId: booking.google_event_id
        });
      } catch (err) {
        console.error("Calendar delete warning:", err.message);
      }
    }

    // =========================
    // 3) Update booking status
    // =========================
    await supabase
  .from("bookings")
  .update({
    status: "reschedule_requested",
    google_event_id: null,
    google_event_html_link: null
  })
  .eq("id", booking.id);

    // 4) Send reschedule email (direct call)
try {
  const { data: bookingWithCustomer } = await supabase
    .from("bookings")
    .select(`
      manage_token,
      customers (
        full_name,
        email
      )
    `)
    .eq("id", booking.id)
    .single();

  if (bookingWithCustomer?.customers?.email) {
    await sendRescheduleLinkEmailCore({
      email: bookingWithCustomer.customers.email,
      fullName: bookingWithCustomer.customers.full_name,
      manageToken: bookingWithCustomer.manage_token
    });
  }
} catch (err) {
  console.error("Reschedule email failed:", err);
}



    return res.status(200).json({
  message: "Reschedule started. Please check your email to pick a new time."
});


  } catch (err) {
    console.error("customer-reschedule-booking error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
