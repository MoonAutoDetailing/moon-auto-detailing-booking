import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import twilio from "twilio";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const adminSecret = requireEnv("ADMIN_SECRET");
    const providedSecret = req.headers["x-admin-secret"];

    if (providedSecret !== adminSecret) {
      return res.status(401).json({ ok: false });
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ ok: false, message: "Missing bookingId" });
    }

    // Supabase (service role)
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // Fetch booking + relations
    const { data: booking, error } = await supabase
  .from("bookings")
  .select("*")
  .eq("id", bookingId)
  .single();

    if (error || !booking) {
      throw new Error("Booking not found");
    }

    // 1️⃣ Create Google Calendar event
    const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
    const saJson = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
    const decoded = Buffer.from(saJson, "base64").toString("utf-8");
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

    // 3️⃣ Send confirmation SMS (only if Twilio configured)
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_PHONE_NUMBER &&
  !booking.customers.sms_opt_out &&
  booking.customers.phone
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

      const formatted = new Date(booking.scheduled_start)
        .toLocaleString("en-US", { timeZone: "America/New_York" });

      const sms = await client.messages.create({
        body: `Hi ${booking.customers.full_name}, your Moon Auto Detailing appointment is confirmed for ${formatted}. Reply STOP to opt out.`,
        from: requireEnv("TWILIO_PHONE_NUMBER"),
        to: booking.customers.phone
      });

      await supabase.from("booking_communications").insert({
        booking_id: booking.id,
        type: "confirmation",
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: sms.sid
      });
    }

    // 4️⃣ Insert reminder rows
    const start = new Date(booking.scheduled_start);

    const reminder24h = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const reminder2h = new Date(start.getTime() - 2 * 60 * 60 * 1000);

    await supabase.from("booking_communications").insert([
      {
        booking_id: booking.id,
        type: "reminder_24h",
        status: "pending",
        scheduled_for: reminder24h.toISOString()
      },
      {
        booking_id: booking.id,
        type: "reminder_2h",
        status: "pending",
        scheduled_for: reminder2h.toISOString()
      }
    ]);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}

