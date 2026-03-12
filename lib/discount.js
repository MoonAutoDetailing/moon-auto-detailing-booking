/**
 * Centralized discount pricing for regular (non-subscription) bookings.
 * Discount applies to service subtotal (base_price) only; travel_fee is unchanged.
 */

/**
 * @param {number} basePrice - Service subtotal
 * @param {number} travelFee - Travel fee (not discounted)
 * @param {number} percentOff - 0–100
 * @returns {{ base_price: number, travel_fee: number, discount_amount: number, total_price: number }}
 */
export function applyDiscountToPricing(basePrice, travelFee, percentOff) {
  const base = Number(basePrice);
  const travel = Number(travelFee);
  const pct = Math.max(0, Math.min(100, Number(percentOff)));
  const discountAmount = Math.round(base * (pct / 100) * 100) / 100;
  const totalPrice = Math.round((base - discountAmount + travel) * 100) / 100;
  return {
    base_price: base,
    travel_fee: travel,
    discount_amount: discountAmount,
    total_price: totalPrice
  };
}
