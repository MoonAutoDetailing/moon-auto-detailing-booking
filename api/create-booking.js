import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "./_rateLimit.js";
import { checkAvailability } from "./_availability.js";

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
  if (req.method !== "POST") return res.status(405).end();

  const rl = rateLimit(req, {
    key: "create-booking",
    limit: 5,
    windowMs: 15 * 60 * 1000
  });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({
      ok: false,
      message: "Too many booking attempts. Please try again in a few minutes."
    });
  }

  try {
    const body = req.body || {};
    const {
      customer_id,
      vehicle_id,
      scheduled_start,
      scheduled_end,
      service_address,
      service_variant_id
    } = body;

    if (!customer_id || !vehicle_id || !scheduled_start || !scheduled_end || !service_address || !service_variant_id) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: customer_id, vehicle_id, scheduled_start, scheduled_end, service_address, service_variant_id"
      });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const isAvailable = await checkAvailability(scheduled_start, scheduled_end);
    if (!isAvailable) {
      return res.status(409).json({
        ok: false,
        message: "Time slot no longer available."
      });
    }

    const manage_token = crypto.randomUUID();
    const { data: booking, error: insertErr } = await supabase
      .from("bookings")
      .insert({
        customer_id,
        vehicle_id,
        service_variant_id,
        service_address,
        scheduled_start,
        scheduled_end,
        status: "pending",
        manage_token
      })
      .select("id, manage_token")
      .single();

    if (insertErr) {
      if (insertErr.code === "23P01" || (insertErr.message || "").includes("bookings_no_overlap")) {
        return res.status(409).json({ ok: false, message: "Time slot no longer available." });
      }
      console.error("[create-booking] insert error", insertErr);
      return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
    }

    if (!booking) {
      return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
    }

    // Trigger booking-requested email (existing route). Do not 500 after insert.
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.BASE_URL || "http://localhost:3000");
    const emailRes = await fetch(`${baseUrl}/api/send-booking-created-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_id: booking.id })
    });
    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error("[EMAIL] type=booking-created booking_id=" + booking.id + " status=failure", errBody);
    }

    return res.status(200).json({
      ok: true,
      bookingId: booking.id,
      manage_token: booking.manage_token
    });
  } catch (err) {
    console.error("create-booking error:", err);
    return res.status(500).json({ ok: false, message: "Booking creation failed. Please try again." });
  }
}
