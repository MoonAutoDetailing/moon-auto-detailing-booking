import { google } from "googleapis";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Validate environment variables at module load to fail fast and avoid runtime drift.
// This ensures reliability by preventing partial execution with missing config.
const adminSecret = requireEnv("ADMIN_SECRET");
const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY").trim();
const resendApiKey = requireEnv("RESEND_API_KEY");
const calendarId = requireEnv("GOOGLE_CALENDAR_ID").trim();
const rawServiceAccount = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON");

// Create Supabase client once per runtime to avoid per-invocation overhead and drift.
// This improves reliability by keeping a single configured client for all requests.
const supabase = createClient(supabaseUrl.trim(), supabaseKey);
console.log("SUPABASE KEY LENGTH:", supabaseKey.length);

// Instantiate Resend once to reuse configuration across invocations.
// This avoids reinitialization per request and keeps behavior consistent.
const resend = new Resend(resendApiKey);

async function sendConfirmationEmail({
  to,
  name,
  booking,
  endTime,
  resendClient,
}) {
  return resendClient.emails.send({
    // TODO: Replace onboarding@resend.dev with a verified sending domain before scaling.
    // This reminder prevents production email failures due to unverified sender domains.
    from: "Moon Auto Detailing <onboarding@resend.dev>",
    to,
    subject: "Your Auto Detail Is Confirmed — Moon Auto Detailing",
    html: `
      <p>Hi ${name},</p>
      <p>Your auto detailing appointment is confirmed.</p>
      <p>
        <strong>Date:</strong> ${new Date(
          booking.scheduled_start
        ).toLocaleDateString()}<br/>
        <strong>Time:</strong> ${new Date(
          booking.scheduled_start
        ).toLocaleTimeString()} – ${endTime.toLocaleTimeString()}<br/>
        <strong>Address:</strong> ${booking.service_address}
      </p>

      <p>— Moon Auto Detailing</p>
    `,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    // ─── Admin auth ─────────────────────────────────────
    const providedSecret =
      req.headers["x-admin-secret"] || req.body?.adminSecret;

    if (providedSecret !== adminSecret) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({
        ok: false,
        message: "Missing bookingId",
      });
    }

    // ─── Load booking + customer ────────────────────────
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select(`
        id,
        status,
        service_variant,
        service_address,
        scheduled_start,
        scheduled_end,
        customers (
          full_name,
          email
        )
      `)
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      throw new Error("Failed to load booking and customer");
    }

    // Validate customer presence before use to prevent null dereferences.
    // This protects reliability by ensuring downstream email logic has required data.
    if (!booking.customers || !booking.customers.email) {
      throw new Error("Missing customer details for booking");
    }

    // Idempotency guard (status defaults to pending, so normalize case).
    // This prevents double-processing when status capitalization differs.
    if ((booking.status || "").toLowerCase() === "confirmed") {
      return res.status(200).json({
        ok: true,
        alreadyConfirmed: true,
      });
    }

    // ─── Google Calendar auth ───────────────────────────
    const creds = JSON.parse(
      Buffer.from(rawServiceAccount, "base64").toString("utf8")
    );

    const privateKey = creds.private_key?.replace(/\\n/g, "\n");
    if (!creds.client_email || !privateKey) {
      throw new Error("Invalid Google service account credentials");
    }

    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      privateKey,
      ["https://www.googleapis.com/auth/calendar"]
    );

    // Ensure the JWT is authorized with correct scopes before use.
    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    // ─── Create calendar event ──────────────────────────
    const startTime = new Date(booking.scheduled_start);
    const scheduledEnd = booking.scheduled_end
      ? new Date(booking.scheduled_end)
      : null;
    const endTime =
      scheduledEnd && scheduledEnd > startTime
        ? scheduledEnd
        : new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // Ensure end is after start.

    const event = {
      // Use a human-friendly summary because service_variant is a UUID.
      summary: "Moon Auto Detailing – Appointment",
      description: `Customer: ${booking.customers.full_name}`,
      location: booking.service_address,
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
    };

    console.log("Calendar event creation started", {
      bookingId,
      start: event.start.dateTime,
      end: event.end.dateTime,
    });

    let calendarResponse;
    try {
      calendarResponse = await calendar.events.insert({
        calendarId,
        requestBody: event,
      });
    } catch (error) {
      // Log the calendar failure details for observability and fast remediation.
      console.error("Calendar event creation failed", { bookingId, error });
      throw error;
    }

    if (!calendarResponse?.data?.id) {
      // Explicitly fail when Google Calendar doesn't return an event ID.
      console.error("Calendar event creation returned no event id", {
        bookingId,
        response: calendarResponse?.data,
      });
      throw new Error("Calendar event creation failed: missing event id");
    }

    console.log("Calendar event created", {
      bookingId,
      eventId: calendarResponse.data.id,
    });

    // ─── Send confirmation email ────────────────────────
    console.log("Email send started", {
      to: booking.customers.email,
      name: booking.customers.full_name,
      bookingId,
    });

    const emailResult = await sendConfirmationEmail({
      to: booking.customers.email,
      name: booking.customers.full_name,
      booking,
      endTime,
      resendClient: resend,
    });

    // Log the full Resend response for troubleshooting and auditability.
    // This improves reliability by preserving vendor feedback for failures.
    console.log("Resend response", emailResult);

    if (emailResult?.error) {
      // Log explicit reconciliation data when email fails after calendar creation.
      console.error("Email delivery failed after calendar event created", {
        bookingId,
        calendarEventId: calendarResponse.data.id,
        customerEmail: booking.customers.email,
        error: emailResult.error,
      });
      // Treat vendor errors as thrown errors to prevent marking bookings confirmed.
      // This ensures reliability by enforcing success-only confirmation.
      throw new Error(`Email delivery failed: ${emailResult.error.message}`);
    }

    if (!emailResult?.data?.id) {
      // Log explicit reconciliation data when email lacks a Resend message id.
      console.error("Email delivery failed after calendar event created", {
        bookingId,
        calendarEventId: calendarResponse.data.id,
        customerEmail: booking.customers.email,
        error: "Missing Resend message id",
      });
      // Enforce Resend message ID presence to confirm successful send.
      // This ensures reliability by avoiding silent delivery failures.
      throw new Error("Email delivery failed: Missing Resend message id");
    }

    // Log a minimal audit record for successful Resend deliveries.
    console.log("Email send succeeded", {
      bookingId,
      resendMessageId: emailResult.data.id,
      recipientEmail: booking.customers.email,
    });

    // ─── Mark booking confirmed ─────────────────────────
    console.log("Booking update started", { bookingId, status: "confirmed" });

    const { error: updateError } = await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId);

    if (updateError) {
      throw new Error("Failed to update booking status");
    }

    console.log("Booking update completed", { bookingId, status: "confirmed" });

    return res.status(200).json({
      ok: true,
      eventId: calendarResponse.data.id,
    });
  } catch (err) {
    console.error("CONFIRM ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
}
