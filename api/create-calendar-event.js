import { google } from "googleapis";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
async function sendConfirmationEmail({ to, name, booking }) {
  return resend.emails.send({
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
        ).toLocaleTimeString()} – ${new Date(
          booking.scheduled_end
        ).toLocaleTimeString()}<br/>
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
    const adminSecret = process.env.ADMIN_SECRET;
    const providedSecret =
      req.headers["x-admin-secret"] || req.body?.adminSecret;

    if (!adminSecret || providedSecret !== adminSecret) {
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
      .select(
        `
        id,
        status,
        service_address,
        scheduled_start,
        scheduled_end,
        customers (
          full_name,
          email
        )
      `
      )
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      throw new Error("Failed to load booking and customer");
    }

    // Idempotency guard
    if (booking.status === "confirmed") {
      return res.status(200).json({
        ok: true,
        alreadyConfirmed: true,
      });
    }

    // ─── Google Calendar auth ───────────────────────────
    const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!calendarId || !raw) {
      throw new Error("Missing Google Calendar configuration");
    }

    const creds = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8")
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

    await auth.authorize();

    const calendar = google.calendar({ version: "v3", auth });

    // ─── Create calendar event ──────────────────────────
    const event = {
      summary: "Auto Detailing Appointment",
      description: `Customer: ${booking.customers.full_name}`,
      location: booking.service_address,
      start: { dateTime: booking.scheduled_start },
      end: { dateTime: booking.scheduled_end },
    };

    const calendarResponse = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    // ─── Send confirmation email ────────────────────────
    console.log("EMAIL DEBUG → about to send", {
  to: booking.customers?.email,
  name: booking.customers?.full_name,
});

try {
  const emailResult = await sendConfirmationEmail({
    to: booking.customers.email,
    name: booking.customers.full_name,
    booking,
  });

  console.log("EMAIL DEBUG → resend response", emailResult);
} catch (err) {
  console.error("EMAIL ERROR → resend failed", err);
}


    // ─── Mark booking confirmed ─────────────────────────
    await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId);

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
