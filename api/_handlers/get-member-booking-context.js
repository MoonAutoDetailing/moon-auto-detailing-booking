import { createClient } from "@supabase/supabase-js";
import { resolveSubscriptionByToken } from "../_subscriptions/resolveSubscriptionByToken.js";
import { buildNextService, planLabel, vehicleLabel } from "../_subscriptions/memberContext.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** GET ?token= — everything the member booking page needs, prefilled from the plan. */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const resolved = await resolveSubscriptionByToken(supabase, token);
    if (resolved.error) return res.status(resolved.status || 500).json({ error: resolved.error });

    const { subscription } = resolved;
    const variant = subscription.service_variants || {};
    const next = await buildNextService(supabase, resolved);
    return res.status(200).json({
      member: {
        full_name: subscription.customers?.full_name || "",
        email: subscription.customers?.email || "",
        phone: subscription.customers?.phone || ""
      },
      vehicle: { label: vehicleLabel(subscription), size: subscription.vehicles?.vehicle_size || null },
      plan: planLabel(subscription),
      service: {
        variant_id: variant.id,
        duration_minutes: variant.duration_minutes,
        label: `${variant.services?.category || "Detail"}${variant.services?.level ? ` Level ${variant.services.level}` : ""}`
      },
      default_address: subscription.default_address || "",
      next_service: next
    });
  } catch (err) {
    console.error("get-member-booking-context error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
