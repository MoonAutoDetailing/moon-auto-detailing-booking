import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import verifyAdmin from "./_verifyAdmin.js";
import { reconcileCustomerLifecycle } from "./_crmWorkflow.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function deleteGoogleEvent(booking) {
  if (!booking.google_event_id) return;

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

  await calendar.events.delete({
    calendarId: requireEnv("GOOGLE_CALENDAR_ID").trim(),
    eventId: booking.google_event_id
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-cancel-booking: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const bookingId = String(req.body?.booking_id || req.body?.bookingId || "").trim();
    if (!bookingId) {
      return res.status(400).json({ ok: false, error: "Missing booking_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, customer_id, status, google_event_id")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingError) throw bookingError;
    if (!booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    if (booking.status === "cancelled") {
      await reconcileCustomerLifecycle(supabase, booking.customer_id);
      return res.status(200).json({ ok: true, already_cancelled: true });
    }

    if (booking.google_event_id) {
      await deleteGoogleEvent(booking);
    }

    const { error: updateError } = await supabase
      .from("bookings")
      .update({
        status: "cancelled",
        google_event_id: null,
        google_event_html_link: null
      })
      .eq("id", bookingId);

    if (updateError) throw updateError;

    await reconcileCustomerLifecycle(supabase, booking.customer_id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-cancel-booking error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
