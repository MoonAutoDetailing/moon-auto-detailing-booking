/**
 * Solo Mode duration: service-specific multiplier map + 15-minute buffer.
 * Does not change base service_variants.duration_minutes or pricing.
 * effective_duration_minutes = ceil(base_duration_minutes * solo_multiplier) + 15
 */

const SOLO_MULTIPLIER_MAP = {
  "Exterior Detail": {
    1: { compact: 1.0, midsized: 1.0, oversized: 1.2 },
    2: { compact: 1.67, midsized: 1.71, oversized: 1.75 }
  },
  "Interior Detail": {
    1: { compact: 1.6, midsized: 1.33, oversized: 1.5 },
    2: { compact: 1.67, midsized: 1.71, oversized: 1.75 }
  },
  "Combined Package": {
    1: { compact: 2.0, midsized: 1.5, oversized: 1.45 },
    2: { compact: 1.75, midsized: 1.68, oversized: 1.64 }
  },
  "Monthly Detail": {
    1: { compact: 1.5, midsized: 1.33, oversized: 1.6 }
  }
};

const SOLO_BUFFER_MINUTES = 15;

function normalizeVehicleSize(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["compact", "midsized", "oversized"].includes(s)) return s;
  return null;
}

function normalizeLevel(lvl) {
  if (lvl == null) return null;
  const n = Number(lvl);
  if (Number.isFinite(n) && (n === 1 || n === 2)) return n;
  return null;
}

/**
 * Get the solo multiplier for a service category / level / vehicle size.
 * Returns 1.0 if no matching rule exists.
 */
export function getSoloMultiplier(category, level, vehicleSize) {
  const cat = category != null ? String(category).trim() : null;
  const lvl = normalizeLevel(level);
  const vs = normalizeVehicleSize(vehicleSize);
  if (!cat || lvl == null || !vs) return 1.0;
  const byLevel = SOLO_MULTIPLIER_MAP[cat];
  if (!byLevel) return 1.0;
  const byVehicle = byLevel[lvl];
  if (!byVehicle) return 1.0;
  const mult = byVehicle[vs];
  return typeof mult === "number" && Number.isFinite(mult) ? mult : 1.0;
}

/**
 * Compute effective duration for Solo Mode.
 * Formula: effective_duration_minutes = ceil(base_duration_minutes * solo_multiplier) + 15
 * Returns { base_duration_minutes, solo_multiplier, effective_duration_minutes, added_minutes }
 */
export function computeSoloEffectiveDuration(baseDurationMinutes, category, level, vehicleSize) {
  const base = Math.max(0, Math.floor(Number(baseDurationMinutes) || 0));
  const mult = getSoloMultiplier(category, level, vehicleSize);
  const afterMultiplier = Math.ceil(base * mult);
  const effective = afterMultiplier + SOLO_BUFFER_MINUTES;
  const added = effective - base;
  return {
    base_duration_minutes: base,
    solo_multiplier: mult,
    effective_duration_minutes: effective,
    added_minutes: added
  };
}
