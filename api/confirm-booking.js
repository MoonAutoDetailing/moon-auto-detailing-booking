import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import twilio from "twilio";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingConfirmedEmailCore } from "../lib/email/sendBookingConfirmedEmail.js";



export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // =========================
    // 1️⃣ Fetch booking
    // =========================
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    // ✅ Idempotency: if an event id exists, do NOT create another event (regardless of status)
    if (booking.google_event_id) {
      // If it’s not confirmed, try to heal status to confirmed (safe, because event id exists)
      if (booking.status !== "confirmed") {
        await supabase
          .from("bookings")
          .update({ status: "confirmed" })
          .eq("id", bookingId);
      }
      return res.status(200).json({ ok: true, alreadyConfirmed: true });
    }

    // Only pending can be confirmed
    if (booking.status !== "pending") {
      return res.status(409).json({ ok: false, message: "Booking not pending" });
    }

    // =========================
    // 2️⃣ Acquire lock: pending -> confirming
    // =========================
    const { data: locked, error: lockError } = await supabase
      .from("bookings")
      .update({ status: "confirming" })
      .eq("id", bookingId)
      .eq("status", "pending")
      .select("id");

    if (lockError) {
      return res.status(500).json({ ok: false, message: "Failed to lock booking" });
    }

    if (!locked || locked.length === 0) {
      return res.status(409).json({ ok: false, message: "Already being confirmed" });
    }

    // =========================
    // 3️⃣ Fetch related data
    // =========================
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("full_name, email, phone")
      .eq("id", booking.customer_id)
      .single();

    if (customerError || !customer) {
      // revert lock
      await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId).eq("status", "confirming");
      return res.status(500).json({ ok: false, message: "Failed to load customer" });
    }

    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("vehicle_year, vehicle_make, vehicle_model, license_plate")
      .eq("id", booking.vehicle_id)
      .single();

    const { data: variant, error: variantError } = await supabase
      .from("service_variants")
      .select("duration_minutes, service_id")
      .eq("id", booking.service_variant_id)
      .single();

    if (variantError || !variant) {
      await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId).eq("status", "confirming");
      return res.status(500).json({ ok: false, message: "Failed to load service variant" });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("category, level")
      .eq("id", variant.service_id)
      .single();

    if (serviceError || !service) {
      await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId).eq("status", "confirming");
      return res.status(500).json({ ok: false, message: "Failed to load service" });
    }

    // =========================
    // 4️⃣ Create Google Calendar event
    // =========================
    const calendarId = process.env.GOOGLE_CALENDAR_ID.trim();
    const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf-8");
    const creds = JSON.parse(decoded);

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"]
    });

    const calendar = google.calendar({ version: "v3", auth });

    const formattedService = `${service.category} Detail Level ${service.level}`;

    const formattedVehicle = [
      vehicle?.vehicle_year,
      vehicle?.vehicle_make,
      vehicle?.vehicle_model
    ].filter(Boolean).join(" ");

    const formattedLicense = vehicle?.license_plate ? ` (${vehicle.license_plate})` : "";

    const summary = `${formattedService} — ${customer.full_name}`;

    const description = [
      `Customer: ${customer.full_name}`,
      `Phone: ${customer.phone || "—"}`,
      `Vehicle: ${formattedVehicle}${formattedLicense}`,
      `Service: ${formattedService}`
    ].join("\n");

    let googleEventId = null;

    try {
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

googleEventId = calendarResponse.data.id;
const googleEventHtmlLink = calendarResponse.data.htmlLink;


      // =========================
      // 5️⃣ Finalize booking (VERIFY IT ACTUALLY UPDATED)
      // =========================
      const { data: updated, error: finalizeError } = await supabase
        .from("bookings")
        .update({
  status: "confirmed",
  google_event_id: googleEventId,
  google_event_html_link: googleEventHtmlLink
})
        .eq("id", bookingId)
        .eq("status", "confirming")
        .is("google_event_id", null)
        .select("id");

      if (finalizeError || !updated || updated.length === 0) {
        // If we can't finalize, clean up the event to avoid orphaned calendar events
        try {
          await calendar.events.delete({ calendarId, eventId: googleEventId });
        } catch (e) {
          console.error("CLEANUP DELETE EVENT FAILED:", e);
        }

        // revert lock (best effort)
        await supabase
          .from("bookings")
          .update({ status: "pending" })
          .eq("id", bookingId)
          .eq("status", "confirming");

        return res.status(409).json({ ok: false, message: "Finalize failed; event cleaned up" });
      }

    } catch (eventErr) {
      // Revert lock so admin can retry
      await supabase
        .from("bookings")
        .update({ status: "pending" })
        .eq("id", bookingId)
        .eq("status", "confirming");

      throw eventErr;
    }

    // =========================
    // 6️⃣ SMS confirmation (unchanged + logging preserved)
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
        // =========================
    // 🔔 Send booking confirmed email (fire-and-forget)
try {
  const { data: variantRow, error: variantErr } = await supabase
  .from("service_variants")
  .select(`price, service:services(category,level)`)
  .eq("id", booking.service_variant_id)
  .single();

if (variantErr) {
  console.error("Service variant lookup failed:", variantErr);
}

const serviceLabel = variantRow?.service
  ? `${variantRow.service.category} Detail ${variantRow.service.level}`
  : "Service";

const price = variantRow?.price ?? null;
  
  await sendBookingConfirmedEmailCore({
  email: customer.email,
  fullName: customer.full_name,
  start: booking.scheduled_start,
  end: booking.scheduled_end,
  address: booking.service_address,
  serviceLabel,
  price
});
  
} catch (err) {
  console.error("Confirmation email failed:", err);
}

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
