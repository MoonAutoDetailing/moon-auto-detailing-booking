import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { resolveSubscriptionById } from "./_subscriptions/resolveSubscriptionById.js";

const VALID_FREQUENCIES = ["biweekly", "monthly", "quarterly"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-change-subscription-plan: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const subscriptionId = req.body?.subscription_id || req.body?.id;
  const serviceVariantId = typeof req.body?.service_variant_id === "string" ? req.body.service_variant_id.trim() : null;
  const frequencyRaw = typeof req.body?.frequency === "string" ? req.body.frequency.trim() : null;

  if (!subscriptionId) {
    return res.status(400).json({ error: "Missing subscription_id" });
  }
  const hasVariant = serviceVariantId !== null && serviceVariantId !== "";
  const hasFrequency = frequencyRaw !== null && frequencyRaw !== "";
  if (!hasVariant && !hasFrequency) {
    return res.status(400).json({ error: "Provide at least one of service_variant_id or frequency." });
  }
  if (hasFrequency && !VALID_FREQUENCIES.includes(frequencyRaw)) {
    return res.status(400).json({ error: "frequency must be exactly one of: biweekly, monthly, quarterly" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionById(supabase, subscriptionId);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription, activeCycle, activeCycleBooking } = resolved;

    if (!activeCycle) {
      return res.status(400).json({ error: "No current open cycle. Plan change is only allowed when there is an open cycle." });
    }
    if (activeCycleBooking) {
      return res.status(400).json({ error: "Current cycle already has a booking. Plan change not allowed." });
    }
    if (activeCycle.status !== "open") {
      return res.status(400).json({ error: "Current cycle is not open. Plan change is only allowed for open cycles." });
    }

    const updates = {};
    const frequency = frequencyRaw !== null && frequencyRaw !== "" ? frequencyRaw : null;
    if (frequency) {
      updates.frequency = frequency;
    }

    let newSubscriptionCategory = subscription.subscription_category;
    if (hasVariant && serviceVariantId) {
      const { data: variant, error: varErr } = await supabase
        .from("service_variants")
        .select("id, service_id, services:service_id ( category )")
        .eq("id", serviceVariantId)
        .single();

      if (varErr || !variant) {
        return res.status(400).json({ error: "Invalid service_variant_id." });
      }
      updates.service_variant_id = serviceVariantId;
      if (variant.services?.category) {
        newSubscriptionCategory = variant.services.category;
        updates.subscription_category = newSubscriptionCategory;
      }
    }

    updates.discount_reset_required = true;

    const { data: updated, error: updateErr } = await supabase
      .from("subscriptions")
      .update(updates)
      .eq("id", subscriptionId)
      .select("id, service_variant_id, frequency, subscription_category, discount_reset_required")
      .single();

    if (updateErr) {
      console.error("admin-change-subscription-plan error:", updateErr);
      return res.status(500).json({ error: "Failed to update plan." });
    }

    return res.status(200).json({
      ok: true,
      message: "Plan updated. Current open cycle will use new plan when booked.",
      subscription: {
        id: updated.id,
        service_variant_id: updated.service_variant_id,
        frequency: updated.frequency,
        subscription_category: updated.subscription_category,
        discount_reset_required: updated.discount_reset_required
      }
    });
  } catch (err) {
    console.error("admin-change-subscription-plan error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
