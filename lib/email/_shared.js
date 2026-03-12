import { formatCurrency } from "../formatCurrency.js";

// Shared, non-invasive helpers for customer communications.
// This file is intentionally small to avoid touching stable booking logic.

function normalizeBaseUrl(url) {
  if (!url) return "";
  return String(url).trim().replace(/\/+$/, "");
}

export function getPublicBaseUrl() {
  // Emails must never rely on request host.
  // PUBLIC_BASE_URL is the source of truth; we keep a safe fallback to avoid hard failures.
  const env = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (env) return env;

  const fallback = "https://moon-auto-detailing-booking.vercel.app";
  console.warn(
    "[emails] PUBLIC_BASE_URL missing; falling back to",
    fallback,
    "(set PUBLIC_BASE_URL in Vercel to remove this warning)"
  );
  return fallback;
}

export function buildManageUrl(manageToken) {
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}/manage-booking.html?token=${manageToken}`;
}

/** Manage Subscription link: use activation booking manage_token (not subscription id). */
export function buildManageSubscriptionUrl(manageToken) {
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}/manage-subscription.html?token=${manageToken}`;
}

export function buildRescheduleUrl(rescheduleToken) {
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}/index.html?reschedule_token=${rescheduleToken}`;
}

export function formatMoneyUSD(amount) {
  return formatCurrency(amount);
}

export function formatServiceName(booking) {
  const svc = booking?.service_variants?.services ?? booking?.service_variant?.service;
  if (!svc) return "Detail Service";

  const category = svc.category?.trim();
  const level = svc.level;

  if (!category) return "Detail Service";
  if (level === null || level === undefined || level === "") return category;

  return `${category} (Level ${level})`;
}

export function pricingBlockHtml({ serviceLabel, price, basePrice, travelFee, totalPrice, discountCode, discountPercent, discountAmount }) {
  const service = serviceLabel || "Service";
  const hasBreakdown = basePrice != null || travelFee != null || totalPrice != null;
  const total = hasBreakdown && totalPrice != null ? formatCurrency(totalPrice) : formatCurrency(price);
  const servicePriceLine = hasBreakdown && basePrice != null
    ? `<div><b>Service price:</b> ${formatCurrency(basePrice)}</div>`
    : `<div><b>Service:</b> ${service}</div>`;
  const travelLine = hasBreakdown && travelFee != null
    ? `<div style="margin-top:6px;"><b>Travel fee:</b> ${formatCurrency(travelFee)}</div>`
    : "";
  const hasDiscount = discountCode != null && (discountAmount != null ? discountAmount > 0 : discountPercent != null);
  const discountLine = hasDiscount
    ? `<div style="margin-top:6px;"><b>Discount (${String(discountCode).replace(/</g, "&lt;")}):</b> -${formatCurrency(discountAmount != null ? discountAmount : 0)}</div>`
    : "";
  const cashNotice = hasBreakdown
    ? "We are a <b>cash-only</b> business. Travel fee is based on inbound drive time."
    : "We are a <b>cash-only</b> business. Travel fees may be added later if applicable.";

  return `
    <div style="margin:14px 0 10px; padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#f9fbff;">
      ${servicePriceLine}
      ${travelLine}
      ${discountLine}
      <div style="margin-top:6px;"><b>Total (cash only):</b> ${total}</div>
      <div style="margin-top:8px; color:#374151; font-size:14px; line-height:1.35;">
        ${cashNotice}
      </div>
    </div>
  `;
}
