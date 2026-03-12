/**
 * Server-side discount code lookup. Expects table discount_codes with:
 * id, code, code_normalized, percent_off, starts_at, ends_at, is_disabled, created_at, updated_at
 */

/** Normalize for lookup: trim, lowercase. Internal spaces/characters preserved in code; code_normalized is unique. */
export function normalizeDiscountCode(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Find an active discount code by normalized code string.
 * Active: starts_at <= now < ends_at (now in America/New_York), !is_disabled.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} codeNormalized
 * @returns {Promise<{ id: string, code: string, percent_off: number, starts_at: string, ends_at: string } | null>}
 */
export async function getActiveDiscountCode(supabase, codeNormalized) {
  if (!codeNormalized) return null;
  const { data: row, error } = await supabase
    .from("discount_codes")
    .select("id, code, code_normalized, percent_off, starts_at, ends_at, is_disabled")
    .eq("code_normalized", codeNormalized)
    .maybeSingle();
  if (error || !row) return null;
  if (row.is_disabled === true) return null;
  const now = new Date();
  const start = row.starts_at ? new Date(row.starts_at).getTime() : 0;
  const end = row.ends_at ? new Date(row.ends_at).getTime() : Infinity;
  if (now < start || now >= end) return null;
  return {
    id: row.id,
    code: row.code,
    percent_off: Number(row.percent_off) || 0,
    starts_at: row.starts_at,
    ends_at: row.ends_at
  };
}
