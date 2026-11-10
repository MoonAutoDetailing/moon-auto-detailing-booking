import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { audit } from "../_subscriptions/cycleState.js";

const VALID_FREQUENCIES = ["biweekly", "monthly", "quarterly"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * POST { subscription_id, frequency?, service_variant_id?, reset_discount? }
 * Queues a plan change for the member's next cycle (the current cycle and any booking are
 * unaffected). The nightly cycle job applies it when it creates the next cycle.
 * reset_discount (default false) makes the next visit full price.
 * POST { subscription_id, cancel_pending: true } clears a queued change.
 */
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

  const body = req.body || {};
  const subscriptionId = body.subscription_id || body.id;
  const serviceVariantId = typeof body.service_variant_id === "string" ? body.service_variant_id.trim() : "";
  const frequency = typeof body.frequency === "string" ? body.frequency.trim() : "";
  if (!subscriptionId) return res.status(400).json({ error: "Missing subscription_id" });

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("id, status, frequency, service_variant_id, pending_frequency, pending_service_variant_id, discount_reset_required")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return res.status(404).json({ error: "Subscription not found." });
    if (sub.status === "cancelled") return res.status(400).json({ error: "This plan is cancelled." });

    if (body.cancel_pending === true) {
      await supabase.from("subscriptions").update({ pending_frequency: null, pending_service_variant_id: null }).eq("id", sub.id);
      await audit(supabase, { subscription_id: sub.id, action: "plan_change_cancelled", actor: "admin", before: { pending_frequency: sub.pending_frequency, pending_service_variant_id: sub.pending_service_variant_id } });
      return res.status(200).json({ ok: true, message: "Queued plan change removed." });
    }

    if (!frequency && !serviceVariantId) {
      return res.status(400).json({ error: "Choose a new frequency or service." });
    }
    if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: "Frequency must be biweekly, monthly, or quarterly." });
    }
    if (serviceVariantId) {
      const { data: variant } = await supabase.from("service_variants").select("id").eq("id", serviceVariantId).maybeSingle();
      if (!variant) return res.status(400).json({ error: "That service option doesn't exist." });
    }

    const update = {
      pending_frequency: frequency && frequency !== sub.frequency ? frequency : null,
      pending_service_variant_id: serviceVariantId && serviceVariantId !== sub.service_variant_id ? serviceVariantId : null
    };
    if (!update.pending_frequency && !update.pending_service_variant_id) {
      return res.status(400).json({ error: "That's already the member's current plan." });
    }
    if (body.reset_discount === true) update.discount_reset_required = true;

    const { error } = await supabase.from("subscriptions").update(update).eq("id", sub.id);
    if (error) {
      console.error("admin-change-subscription-plan error:", error);
      return res.status(500).json({ error: "Failed to save the plan change." });
    }
    await audit(supabase, {
      subscription_id: sub.id,
      action: "plan_change_queued",
      actor: "admin",
      before: { frequency: sub.frequency, service_variant_id: sub.service_variant_id },
      after: update
    });
    return res.status(200).json({ ok: true, message: "Plan change saved. It takes effect from the member's next service window." });
  } catch (err) {
    console.error("admin-change-subscription-plan error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
