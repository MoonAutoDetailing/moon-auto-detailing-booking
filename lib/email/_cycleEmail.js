import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "../../api/_subscriptions/lifecycle.js";
import { resolveMemberPrice } from "../../api/_subscriptions/cycleState.js";
import { planLabel, vehicleLabel } from "../../api/_subscriptions/memberContext.js";
import { buildManageSubscriptionUrl, buildMemberBookingUrl } from "./_shared.js";

// Shared loader + layout for maintenance-cycle emails (open, reminders, pushback, missed).

export function niceDate(d, long = false) {
  if (!d) return "";
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", long
    ? { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }
    : { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export function money(n) {
  const v = Number(n || 0);
  return "$" + (Number.isInteger(v) ? v : v.toFixed(2));
}

export async function loadCycleEmailContext(cycleId) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: cycle } = await sb
    .from("subscription_cycles")
    .select(`
      id, cycle_index, status, window_start_date, window_end_date, opens_on,
      pushback_used, pushback_end_date, free_pushback, subscription_id,
      subscriptions(
        id, status, frequency, subscription_category, discount_reset_required, activation_booking_id,
        customers(full_name, email),
        vehicles:vehicle_id(vehicle_size, vehicle_year, vehicle_make, vehicle_model),
        service_variants:service_variant_id(price, services:service_id(category, level))
      )
    `)
    .eq("id", cycleId)
    .single();
  const sub = cycle?.subscriptions;
  if (!sub?.customers?.email) throw new Error("Cycle or customer lookup failed for cycle email");

  const { data: activation } = sub.activation_booking_id
    ? await sb.from("bookings").select("manage_token").eq("id", sub.activation_booking_id).maybeSingle()
    : { data: null };
  const token = activation?.manage_token || null;
  if (!token) throw new Error("Plan link (activation booking manage_token) missing for cycle email");

  const variant = sub.service_variants || {};
  const price = await resolveMemberPrice(sb, sub, {
    price: variant.price,
    vehicle_size: sub.vehicles?.vehicle_size,
    service: variant.services
  });
  const plan = planLabel({ ...sub, service_variants: variant });
  return {
    cycle,
    subscription: sub,
    firstName: (sub.customers.full_name || "").split(" ")[0] || "there",
    email: sub.customers.email,
    vehicle: vehicleLabel(sub),
    plan,
    price,
    effectiveEnd: getEffectiveWindowEnd(cycle),
    bookUrl: buildMemberBookingUrl(token),
    planUrl: buildManageSubscriptionUrl(token)
  };
}

export function priceSentence(price) {
  if (price.price_mode === "discounted") return `Your member price is ${money(price.base_price)} (plus any travel fee), paid after service.`;
  if (price.reason === "missed_cycle") {
    return `This visit is ${money(price.base_price)} (full price, because the last window was missed). Member pricing${price.member_price ? ` of ${money(price.member_price)}` : ""} returns on the visit after.`;
  }
  return `This visit is ${money(price.base_price)} (plus any travel fee), paid after service.`;
}

export function layout({ heading, paragraphs, button, footer }) {
  const btn = button
    ? `<p style="margin:24px 0"><a href="${button.url}" style="background:#5ca7df;color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${button.label}</a></p>`
    : "";
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1c1c1c;max-width:560px">
      <h2 style="margin:0 0 12px">${heading}</h2>
      ${paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join("")}
      ${btn}
      ${footer ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280">${footer}</p>` : ""}
    </div>`;
}
