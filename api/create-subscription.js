import { createClient } from "@supabase/supabase-js";
import { sendSubscriptionCreatedEmailCore } from "../lib/email/sendSubscriptionCreatedEmail.js";

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

    const { data: subscription, error: insertErr } = await supabase
      .from("subscriptions")
      .insert({
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
