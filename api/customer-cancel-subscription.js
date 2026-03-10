import { createClient } from "@supabase/supabase-js";
import { resolveSubscriptionByToken } from "./_subscriptions/resolveSubscriptionByToken.js";

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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = req.body?.token ?? req.query?.token;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionByToken(supabase, token);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription } = resolved;

    if (!subscription) {
      return res.status(400).json({ error: "Subscription not found." });
    }
    if (subscription.status === "cancelled") {
      return res.status(400).json({ error: "Subscription is already cancelled." });
    }
    const completed = subscription.completed_cycles_count ?? 0;
    if (completed < 3) {
      return res.status(400).json({
        error: "You must complete at least 3 cycles before cancelling your subscription."
      });
    }

    const { data: updated, error: updateErr } = await supabase
      .from("subscriptions")
      .update({ status: "cancelled" })
      .eq("id", subscription.id)
      .select("id, status, completed_cycles_count, missed_cycles_count")
      .single();

    if (updateErr) {
      console.error("customer-cancel-subscription error:", updateErr);
      return res.status(500).json({ error: "Failed to cancel subscription." });
    }

    return res.status(200).json({
      ok: true,
      message: "Subscription cancelled.",
      subscription: {
        id: updated.id,
        status: updated.status,
        completed_cycles_count: updated.completed_cycles_count,
        missed_cycles_count: updated.missed_cycles_count
      }
    });
  } catch (err) {
    console.error("customer-cancel-subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
