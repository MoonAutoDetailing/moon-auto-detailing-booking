import verifyAdmin from "../_verifyAdmin.js";
import { resumeSubscription } from "../_subscriptions/cycleState.js";
import { createClient } from "@supabase/supabase-js";
import { resolveSubscriptionById } from "../_subscriptions/resolveSubscriptionById.js";

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
    console.error("admin-resume-subscription: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const subscriptionId = req.body?.subscription_id || req.body?.id;
  if (!subscriptionId) {
    return res.status(400).json({ error: "Missing subscription_id" });
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

    const { subscription } = resolved;
    if (subscription.status === "cancelled") {
      return res.status(400).json({ error: "Cannot resume a cancelled subscription." });
    }
    if (subscription.status !== "paused") {
      return res.status(400).json({ error: "Only paused subscriptions can be resumed." });
    }

    // Re-anchor to today so the next window is one cadence period from now, not in the past.
    const resumed = await resumeSubscription(supabase, subscription, { actor: "admin" });
    const { data: updated, error: updateErr } = await supabase
      .from("subscriptions")
      .select("id, status, anchor_date, frequency")
      .eq("id", subscriptionId)
      .single();

    if (updateErr) {
      console.error("admin-resume-subscription error:", updateErr);
      return res.status(500).json({ error: "Failed to resume subscription." });
    }

    return res.status(200).json({
      ok: true,
      message: resumed.next_window
        ? `Subscription resumed. Next service window: ${resumed.next_window.start} – ${resumed.next_window.end}.`
        : "Subscription resumed.",
      subscription: { id: updated.id, status: updated.status, anchor_date: updated.anchor_date, frequency: updated.frequency },
      next_window: resumed.next_window
    });
  } catch (err) {
    console.error("admin-resume-subscription error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
