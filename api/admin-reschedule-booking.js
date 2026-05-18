import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingRescheduledEmailCore } from "../lib/email/sendBookingRescheduledEmail.js";

const ALLOWED_STATUSES = ["pending", "confirmed"];
const FORBIDDEN_FIELDS = [
  "scheduled_end",
  "base_price",
  "custom_base_price",
  "custom_price_enabled",
  "price",
  "service_variant_id",
  "customer_id",
  "vehicle_id",
  "status",
  "travel_fee",
  "travel_minutes",
  "total_price",
  "discount_amount",
  "discount_code",
  "discount_percent",
  "subscription_id",
  "subscription_mode",
  "subscription_category",
  "subscription_frequency",
  "google_event_id",
  "google_event_html_link",
  "manage_token"
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function getCalendarClient() {
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
  return google.calendar({ version: "v3", auth });
}

function isBookingOverlapError(err) {
  const message = String(err?.message || "").toLowerCase();
  const details = String(err?.details || "").toLowerCase();
  return err?.code === "23P01" ||
    message.includes("bookings_no_overlap") ||
    details.includes("bookings_no_overlap") ||
    message.includes("exclusion constraint") ||
    details.includes("exclusion constraint");
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        return res.status(400).json({ ok: false, error: `${field} cannot be changed by admin reschedule` });
      }
    }

    const bookingId = String(body.booking_id || "").trim();
    const scheduledStartRaw = body.scheduled_start;
    const sendCustomerEmail = body.send_customer_email === true;

    if (!bookingId) {
      return res.status(400).json({ ok: false, error: "Missing booking_id" });
    }

    const scheduledStart = new Date(scheduledStartRaw);
    if (!scheduledStartRaw || Number.isNaN(scheduledStart.getTime())) {
      return res.status(400).json({ ok: false, error: "scheduled_start is invalid" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, status, service_variant_id, google_event_id, scheduled_start, scheduled_end")
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      return res.status(404).json({ ok: false, error: "Booking not found" });
    }

    if (!ALLOWED_STATUSES.includes(booking.status)) {
      return res.status(409).json({
        ok: false,
        error: "This booking cannot be rescheduled from its current status."
      });
    }

    const { data: variant, error: variantError } = await supabase
      .from("service_variants")
      .select("duration_minutes")
      .eq("id", booking.service_variant_id)
      .single();

    if (variantError || !variant) {
      return res.status(500).json({ ok: false, error: "Failed to load service variant duration" });
    }

    const durationMinutes = Number(variant.duration_minutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ ok: false, error: "Service variant is missing a valid duration" });
    }

    const scheduledStartIso = scheduledStart.toISOString();
    const scheduledEndIso = new Date(scheduledStart.getTime() + durationMinutes * 60000).toISOString();
    let warning;

    if (booking.status === "confirmed" && booking.google_event_id) {
      try {
        const calendar = getCalendarClient();
        await calendar.events.patch({
          calendarId: requireEnv("GOOGLE_CALENDAR_ID").trim(),
          eventId: booking.google_event_id,
          requestBody: {
            start: { dateTime: scheduledStartIso },
            end: { dateTime: scheduledEndIso }
          }
        });
      } catch (calendarError) {
        console.error("[ADMIN_RESCHEDULE] calendar_update_failed booking_id=" + booking.id, calendarError);
        return res.status(500).json({ ok: false, error: "Google Calendar update failed" });
      }
    } else if (booking.status === "confirmed") {
      warning = "Booking rescheduled, but no Google Calendar event was linked.";
      console.warn("[ADMIN_RESCHEDULE] confirmed_missing_google_event_id booking_id=" + booking.id);
    }

    const { data: updatedRows, error: updateError } = await supabase
      .from("bookings")
      .update({
        scheduled_start: scheduledStartIso,
        scheduled_end: scheduledEndIso
      })
      .eq("id", booking.id)
      .eq("status", booking.status)
      .select("id");

    if (updateError || !updatedRows || updatedRows.length === 0) {
      console.error("[ADMIN_RESCHEDULE] db_update_failed", {
        booking_id: bookingId,
        code: updateError?.code,
        message: updateError?.message,
        details: updateError?.details
      });
      if (isBookingOverlapError(updateError)) {
        return res.status(409).json({
          ok: false,
          error: "This time overlaps another booking. Choose a different time or adjust the calendar manually."
        });
      }
      const logKey = booking.status === "confirmed" && booking.google_event_id
        ? "serious_db_update_failed_after_calendar_update"
        : "db_update_failed";
      console.error("[ADMIN_RESCHEDULE] " + logKey, {
        booking_id: bookingId,
        no_rows_updated: !updateError && (!updatedRows || updatedRows.length === 0)
      });
      return res.status(500).json({ ok: false, error: "Database update failed" });
    }

    if (sendCustomerEmail) {
      try {
        const emailResult = await sendBookingRescheduledEmailCore(booking.id);
        if (!emailResult?.success) {
          throw new Error(emailResult?.error?.message || "Rescheduled email failed");
        }
        console.log("[EMAIL] type=booking-rescheduled booking_id=" + booking.id + " status=success");
      } catch (emailError) {
        console.error("[EMAIL] type=booking-rescheduled booking_id=" + booking.id + " status=failure", emailError);
        warning = warning || "Booking rescheduled, but the customer email failed.";
      }
    }

    return res.status(200).json({
      ok: true,
      booking_id: booking.id,
      scheduled_start: scheduledStartIso,
      scheduled_end: scheduledEndIso,
      ...(warning ? { warning } : {})
    });
  } catch (err) {
    console.error("admin-reschedule-booking error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
}
