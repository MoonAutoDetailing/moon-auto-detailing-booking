import { createClient } from "@supabase/supabase-js";
import { sendSubscriptionCreatedEmailCore } from "../../lib/email/sendSubscriptionCreatedEmail.js";
import { isSeasonClosed, SEASON_CLOSED_MESSAGE } from "../_seasonStatus.js";
import { normalizePlanCategory } from "../_subscriptions/cycleState.js";

const VALID_FREQUENCIES = ["biweekly", "monthly", "quarterly"];

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

  // New maintenance enrollments go to the waitlist while closed.
  if (isSeasonClosed()) {
    return res.status(403).json({ ok: false, seasonClosed: true, message: SEASON_CLOSED_MESSAGE });
  }

  try {
    const body = req.body || {};
    const {
      customer_id,
      vehicle_id,
      service_variant_id,
      default_address,
      frequency,
      activation_booking_id
    } = body;

    if (!customer_id || !vehicle_id || !service_variant_id || !default_address || !frequency || !activation_booking_id) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields: customer_id, vehicle_id, service_variant_id, default_address, frequency, activation_booking_id"
      });
    }

    // Only the person who just made the activation booking can enroll it: they hold that
    // booking's private link token, and the customer/vehicle/service must match the booking.
    if (!body.manage_token || typeof body.manage_token !== "string") {
      return res.status(403).json({ ok: false, message: "Missing booking link. Please refresh and try again." });
    }

    if (!VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({
        ok: false,
        message: "frequency must be one of: biweekly, monthly, quarterly"
      });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: activation, error: actErr } = await supabase
      .from("bookings")
      .select("id, manage_token, customer_id, vehicle_id, service_variant_id, status")
      .eq("id", activation_booking_id)
      .maybeSingle();
    if (actErr) throw actErr;
    if (
      !activation ||
      activation.manage_token !== body.manage_token ||
      activation.customer_id !== customer_id ||
      activation.vehicle_id !== vehicle_id ||
      activation.service_variant_id !== service_variant_id ||
      ["cancelled", "denied"].includes(activation.status)
    ) {
      return res.status(403).json({ ok: false, message: "This booking can't be used to start a plan." });
    }

    const { data: existing } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("vehicle_id", vehicle_id)
      .eq("service_variant_id", service_variant_id)
      .in("status", ["pending_activation", "active"])
      .limit(1)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: "A subscription already exists for this vehicle and service."
      });
    }

    // Plan category (combined/interior/exterior) drives member pricing and portal labels.
    const { data: variantRow } = await supabase
      .from("service_variants")
      .select("services:service_id(category)")
      .eq("id", service_variant_id)
      .maybeSingle();
    const subscription_category =
      normalizePlanCategory(body.subscription_category) || normalizePlanCategory(variantRow?.services?.category);

    const { data: subscription, error: insertErr } = await supabase
      .from("subscriptions")
      .insert({
        subscription_category,
        customer_id,
        vehicle_id,
        service_variant_id,
        default_address,
        frequency,
        status: "pending_activation",
        activation_booking_id
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[create-subscription] insert error", insertErr);
      return res.status(500).json({ ok: false, message: "Subscription creation failed. Please try again." });
    }

    if (!subscription) {
      return res.status(500).json({ ok: false, message: "Subscription creation failed. Please try again." });
    }

    console.log("SUBSCRIPTION_CREATED", { subscription_id: subscription.id });

    try {
      await sendSubscriptionCreatedEmailCore(subscription.id);
      console.log("[EMAIL] type=subscription-created subscription_id=" + subscription.id + " status=success");
    } catch (emailErr) {
      console.error("[EMAIL] type=subscription-created subscription_id=" + subscription.id + " status=failure", emailErr);
    }

    return res.status(200).json({
      ok: true,
      subscription_id: subscription.id
    });
  } catch (err) {
    console.error("create-subscription error:", err);
    return res.status(500).json({ ok: false, message: "Subscription creation failed. Please try again." });
  }
}
