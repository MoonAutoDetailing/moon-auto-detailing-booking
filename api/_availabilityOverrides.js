import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

/**
 * Determine if a date is eligible for slot generation and optional time-range filter.
 * - blocked/full_day => not eligible (no slots).
 * - open/full_day or no override and weekday in allowed => eligible, no time filter.
 * - open/time_range => eligible (e.g. weekend opened for a window), filter: keep only slots overlapping window.
 * - blocked/time_range => eligible only if weekday in allowed; filter: remove slots overlapping window.
 * @param {string} dayStr - YYYY-MM-DD
 * @param {number[]} allowedWeekdays - e.g. [1,2,3,4,5] for Mon–Fri
 * @returns {{ allowed: boolean, override: object | null, timeRangeFilter: { mode: 'open'|'blocked', start_time: string, end_time: string } | null }}
 */
export async function getDateEligibility(dayStr, allowedWeekdays) {
  const supabase = getSupabase();
  const [yy, mm, dd] = dayStr.split("-").map(Number);
  const weekday = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();

  const { data: row } = await supabase
    .from("availability_overrides")
    .select("id, override_date, mode, scope, start_time, end_time, google_event_id")
    .eq("override_date", dayStr)
    .maybeSingle();

  if (row && row.scope === "full_day" && row.mode === "blocked") {
    return { allowed: false, override: row, timeRangeFilter: null };
  }
  if (row && row.scope === "full_day" && row.mode === "open") {
    return { allowed: true, override: row, timeRangeFilter: null };
  }
  if (row && row.scope === "time_range" && row.mode === "open") {
    if (!row.start_time || !row.end_time) return { allowed: false, override: row, timeRangeFilter: null };
    return {
      allowed: true,
      override: row,
      timeRangeFilter: { mode: "open", start_time: row.start_time, end_time: row.end_time },
    };
  }
  if (row && row.scope === "time_range" && row.mode === "blocked") {
    if (!row.start_time || !row.end_time) return { allowed: false, override: row, timeRangeFilter: null };
    if (!allowedWeekdays.includes(weekday)) {
      return { allowed: false, override: row, timeRangeFilter: null };
    }
    return {
      allowed: true,
      override: row,
      timeRangeFilter: { mode: "blocked", start_time: row.start_time, end_time: row.end_time },
    };
  }
  if (allowedWeekdays.includes(weekday)) {
    return { allowed: true, override: null, timeRangeFilter: null };
  }
  return { allowed: false, override: null, timeRangeFilter: null };
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
    .select("id, override_date, mode, scope, start_time, end_time, reason, google_event_id, created_at, updated_at")
    .gte("override_date", startDate)
    .lte("override_date", endDate)
    .order("override_date", { ascending: true });
  if (error) throw error;
  return data || [];
}
