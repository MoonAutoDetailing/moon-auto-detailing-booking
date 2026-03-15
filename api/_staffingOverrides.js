/**
 * Check if a date has Solo Mode enabled via staffing_overrides.
 * @param {object} supabase - Supabase client (service role)
 * @param {string} dayStr - YYYY-MM-DD
 * @returns {Promise<boolean>}
 */
export async function isSoloMode(supabase, dayStr) {
  if (!dayStr || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return false;
  const { data } = await supabase
    .from("staffing_overrides")
    .select("override_date")
    .eq("override_date", dayStr)
    .eq("solo_mode", true)
    .maybeSingle();
  return !!data;
}
