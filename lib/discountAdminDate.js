/**
 * Parse admin-entered datetime as America/New_York and return ISO string for storage.
 * Used so discount code start/end are deterministic and not tied to browser timezone.
 * Accepts "YYYY-MM-DDTHH:mm" (datetime-local) or "YYYY-MM-DD HH:mm" or ISO-like string.
 */

import { DateTime } from "luxon";

const BUSINESS_TZ = "America/New_York";

/**
 * @param {string} localDatetime - Admin input e.g. "2025-03-01T08:00" or "2025-03-01 08:00"
 * @returns {{ ok: true, iso: string } | { ok: false, error: string }}
 */
export function parseAdminDatetimeAsNewYork(localDatetime) {
  const s = String(localDatetime || "").trim();
  if (!s) return { ok: false, error: "Empty datetime" };

  // Normalize: allow space or T between date and time
  const normalized = s.replace(" ", "T");
  let dt = DateTime.fromFormat(normalized, "yyyy-MM-dd'T'HH:mm", { zone: BUSINESS_TZ });
  if (!dt.isValid) {
    dt = DateTime.fromISO(normalized, { zone: BUSINESS_TZ });
  }
  if (!dt.isValid) {
    return { ok: false, error: "Invalid datetime format. Use YYYY-MM-DD and time." };
  }
  const iso = dt.toUTC().toISO();
  if (!iso) return { ok: false, error: "Invalid datetime." };
  return { ok: true, iso };
}
