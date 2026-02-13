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
    if (!bookingId) {
      return res.status(400).json({ ok: false, message: "Missing bookingId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // =========================
    // 1️⃣ Fetch booking
    // =========================
    const { data: booking } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .single();

    if (!booking) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    // Already confirmed?
    if (booking.status === "confirmed" && booking.google_event_id) {
      return res.status(200).json({ ok: true, alreadyConfirmed: true });
    }

    if (booking.status !== "pending") {
      return res.status(409).json({ ok: false, message: "Booking not pending" });
    }

    // =========================
    // 2️⃣ Acquire lock
    // =========================
    const { data: locked } = await supabase
      .from("bookings")
      .update({ status: "confirming" })
      .eq("id", bookingId)
      .eq("status", "pending")
      .select("id");

    if (!locked || locked.length === 0) {
      return res.status(409).json({ ok: false, message: "Already being confirmed" });
    }

    // =========================
    // 3️⃣ Fetch related data (UNCHANGED)
    // =========================
    const { data: customer } = await supabase
      .from("customers")
      .select("full_name, phone, sms_opt_out")
      .eq("id", booking.customer_id)
      .single();

    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("vehicle_year, vehicle_make, vehicle_model, license_plate")
      .eq("id", booking.vehicle_id)
      .single();

    const { data: variant } = await supabase
      .from("service_variants")
      .select("duration_minutes, service_id")
      .eq("id", booking.service_variant_id)
      .single();

    const { data: service } = await supabase
      .from("services")
      .select("category, level")
      .eq("id", variant.service_id)
      .single();

    // =========================
    // 4️⃣ Create Google Event (SINGLE INSERT)
    // =========================
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

    const formattedService = `${service.category} Detail Level ${service.level}`;
    const formattedVehicle = [
      vehicle.vehicle_year,
      vehicle.vehicle_make,
      vehicle.vehicle_model
    ].filter(Boolean).join(" ");

    const formattedLicense = vehicle.license_plate
      ? ` (${vehicle.license_plate})`
      : "";

    const summary = `${formattedService} — ${customer.full_name}`;

    const description = [
      `Customer: ${customer.full_name}`,
      `Phone: ${customer.phone || "—"}`,
      `Vehicle: ${formattedVehicle}${formattedLicense}`,
      `Service: ${formattedService}`
    ].join("\n");

    const calendarResponse = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        location: booking.service_address,
        description,
        start: { dateTime: booking.scheduled_start },
        end: { dateTime: booking.scheduled_end }
      }
    });

    const googleEventId = calendarResponse.data.id;

    // =========================
    // 5️⃣ Finalize booking
    // =========================
    await supabase
      .from("bookings")
      .update({
        status: "confirmed",
        google_event_id: googleEventId
      })
      .eq("id", bookingId)
      .eq("status", "confirming");

    // =========================
    // 6️⃣ SMS (UNCHANGED + LOGGING PRESERVED)
    // =========================
    if (
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER &&
      customer.phone &&
      !customer.sms_opt_out
    ) {
      try {
        const client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );

        const formatted = new Date(booking.scheduled_start)
          .toLocaleString("en-US", { timeZone: "America/New_York" });

        const sms = await client.messages.create({
          body: `Hi ${customer.full_name}, your Moon Auto Detailing appointment is confirmed for ${formatted}. Reply STOP to opt out.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customer.phone
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
