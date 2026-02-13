import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import twilio from "twilio";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const adminSecret = process.env.ADMIN_SECRET;
    if (req.headers["x-admin-secret"] !== adminSecret) {
      return res.status(401).json({ ok: false });
    }

    const { bookingId } = req.body;
    console.log("BOOKING ID RECEIVED:", bookingId);
    if (!bookingId) {
      return res.status(400).json({ ok: false, message: "Missing bookingId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // DEBUG: simple fetch only
const { data: booking, error } = await supabase
  .from("bookings")
  .select(`
    id,
    scheduled_start,
    scheduled_end,
    service_address,
    status,
    customers:customer_id (
      full_name,
      phone,
      sms_opt_out
    ),
    vehicles:vehicle_id (
      vehicle_year,
      vehicle_make,
      vehicle_model
    ),
    service_variants:service_variant_id (
      duration_minutes,
      services:service_id (
        category,
        level
      )
    )
  `)
  .eq("id", bookingId)
  .single();


    if (error || !booking) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    // 1️⃣ Create Google Calendar event
    const calendarId = process.env.GOOGLE_CALENDAR_ID.trim();
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

    const summary = `${booking.service_variants.services.category} Level ${booking.service_variants.services.level} — ${booking.customers.full_name}`;

    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        location: booking.service_address,
        start: { dateTime: booking.scheduled_start },
        end: { dateTime: booking.scheduled_end }
      }
    });

    // 2️⃣ Update booking status
    await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId);

    // 3️⃣ Send SMS confirmation (if configured)
    if (
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER &&
      booking.customers.phone &&
      !booking.customers.sms_opt_out
    ) {
      try {
        const client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );

        const formatted = new Date(booking.scheduled_start)
          .toLocaleString("en-US", { timeZone: "America/New_York" });

        const sms = await client.messages.create({
          body: `Hi ${booking.customers.full_name}, your Moon Auto Detailing appointment is confirmed for ${formatted}. Reply STOP to opt out.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: booking.customers.phone
        });

        await supabase.from("booking_communications").insert({
          booking_id: booking.id,
          type: "confirmation",
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_message_id: sms.sid
        });

      } catch (smsError) {
        console.error("SMS ERROR:", smsError);
      }
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
