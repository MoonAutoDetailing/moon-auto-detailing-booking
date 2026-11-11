// A customer's saved service addresses: their profile address plus every address they've
// been booked at, newest first, without near-duplicates ("…, NJ 07090, USA" vs "…, NJ 07090").

const PLACEHOLDERS = new Set(["", "address not provided", "n/a", "none", "unknown"]);

export function isPlaceholderAddress(address) {
  return PLACEHOLDERS.has(String(address || "").trim().toLowerCase());
}

export function addressKey(address) {
  return String(address || "")
    .toLowerCase()
    .replace(/,?\s*(usa|united states)\.?$/i, "")
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param bookingAddresses service addresses from bookings, newest first
 * @param profileAddress   customers.address
 * @returns up to `limit` unique addresses, newest booking first, profile address included
 */
export function savedAddresses({ bookingAddresses = [], profileAddress = null, limit = 6 }) {
  const out = [];
  const seen = new Set();
  for (const a of [...bookingAddresses, profileAddress]) {
    if (isPlaceholderAddress(a)) continue;
    const key = addressKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(a).trim());
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadSavedAddresses(sb, customerId) {
  const [{ data: customer, error: cErr }, { data: bookings, error: bErr }] = await Promise.all([
    sb.from("customers").select("address").eq("id", customerId).maybeSingle(),
    sb
      .from("bookings")
      .select("service_address, scheduled_start")
      .eq("customer_id", customerId)
      .order("scheduled_start", { ascending: false })
      .limit(40),
  ]);
  if (cErr) throw cErr;
  if (bErr) throw bErr;
  return savedAddresses({
    bookingAddresses: (bookings || []).map((b) => b.service_address),
    profileAddress: customer?.address,
  });
}

/** Saves the address on the customer when their profile has none yet. Never overwrites. */
export async function rememberCustomerAddress(sb, customerId, address) {
  if (!customerId || isPlaceholderAddress(address)) return false;
  const { data, error } = await sb.from("customers").select("address").eq("id", customerId).maybeSingle();
  if (error || !data || !isPlaceholderAddress(data.address)) return false;
  const { error: upErr } = await sb.from("customers").update({ address: String(address).trim() }).eq("id", customerId);
  return !upErr;
}
