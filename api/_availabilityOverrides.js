import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

/**
 * Determine if a date is eligible for slot generation.
 * - If there is a full-day blocked override => not eligible.
 * - If there is a full-day open override => eligible (even if normally closed, e.g. weekend).
 * - Else if weekday is in allowedWeekdays => eligible.
 * - Else => not eligible.
 * @param {string} dayStr - YYYY-MM-DD
 * @param {number[]} allowedWeekdays - e.g. [1,2,3,4,5] for Mon–Fri
 * @returns {{ allowed: boolean, override: object | null }}
 */
export async function getDateEligibility(dayStr, allowedWeekdays) {
  const supabase = getSupabase();
  const [yy, mm, dd] = dayStr.split("-").map(Number);
  const weekday = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();

  const { data: row } = await supabase
    .from("availability_overrides")
    .select("id, override_date, mode, scope, google_event_id")
    .eq("override_date", dayStr)
    .eq("scope", "full_day")
    .maybeSingle();

  if (row && row.mode === "blocked") {
    return { allowed: false, override: row };
  }
  if (row && row.mode === "open") {
    return { allowed: true, override: row };
  }
  if (allowedWeekdays.includes(weekday)) {
    return { allowed: true, override: null };
  }
  return { allowed: false, override: null };
}

/**
 * Fetch overrides for a date range (for admin list).
 * @param {string} startDate - YYYY-MM-DD inclusive
 * @param {string} endDate - YYYY-MM-DD inclusive
 */
export async function getOverridesForRange(startDate, endDate) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("availability_overrides")
    .select("id, override_date, mode, scope, reason, google_event_id, created_at, updated_at")
    .gte("override_date", startDate)
    .lte("override_date", endDate)
    .order("override_date", { ascending: true });
  if (error) throw error;
  return data || [];
}
