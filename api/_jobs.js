// Crew job helpers: which checklist steps apply to a booking, what still blocks completion,
// New York day ranges, and the job shape the crew app receives. Pure functions are exported
// separately so tests can cover the rules without a database.

import { DateTime } from "luxon";

const BUSINESS_TZ = "America/New_York";
export const PHOTO_BUCKET = "job-media";
export const PHOTO_KINDS = ["before", "after", "issue"];

/**
 * The guided before/after shots. Before and after use the same list, so every angle is
 * photographed twice. Interior shots apply to interior work, exterior shots to exterior work
 * (and ceramic); optional shots never block completion. The crew app draws a line sketch
 * for each key (photo-guides.js).
 */
export const PHOTO_SHOTS = [
  { key: "front_driver", area: "interior", label: "Front driver", tip: "Open the driver door. Seat, floor, center console, steering wheel and door panel all in frame." },
  { key: "front_passenger", area: "interior", label: "Front passenger", tip: "Open the passenger door. Seat, floor, center console, dashboard and door panel all in frame." },
  { key: "center_console", area: "interior", label: "Center console & screen", tip: "From the back seat, between the front seats. Center console, cupholders, shifter and the dash screen/radio all in frame." },
  { key: "rear_driver", area: "interior", label: "Back driver side", tip: "Open the rear driver door. Back seat, floor, back of the front seat and door panel in frame." },
  { key: "rear_passenger", area: "interior", label: "Back passenger side", tip: "Open the rear passenger door. Back seat, floor, back of the front seat and door panel in frame." },
  { key: "third_driver", area: "interior", label: "3rd row, driver side", tip: "Only if the vehicle has a 3rd row. Seat and floor in frame.", optional: true },
  { key: "third_passenger", area: "interior", label: "3rd row, passenger side", tip: "Only if the vehicle has a 3rd row. Seat and floor in frame.", optional: true },
  { key: "trunk", area: "interior", label: "Trunk", tip: "Trunk or hatch fully open. Whole cargo floor and both sides in frame." },
  { key: "ext_front", area: "exterior", label: "Front, straight on", tip: "Stand in front of the car, centered. Whole front end, bumper to roof, in frame." },
  { key: "ext_front_right", area: "exterior", label: "Front ¾, passenger side", tip: "Stand off the front passenger corner. Front end and the whole passenger side in frame." },
  { key: "ext_rear_left", area: "exterior", label: "Rear ¾, driver side", tip: "Stand off the rear driver corner. Back end and the whole driver side in frame." },
  { key: "ext_wheel", area: "exterior", label: "Wheel", tip: "Crouch level with a front wheel. Tire, rim and brake area fill the frame." },
];
const SHOT_KEYS = new Set(PHOTO_SHOTS.map((s) => s.key));
export const isShotKey = (k) => SHOT_KEYS.has(k);
const SHOT_INDEX = new Map(PHOTO_SHOTS.map((s, i) => [s.key, i]));
/** Sorts photos into shot order (guided angles first, in shooting order; others after, by time). */
export const byShotOrder = (a, b) => (SHOT_INDEX.get(a.shot) ?? 99) - (SHOT_INDEX.get(b.shot) ?? 99);
export const shotLabel = (k) => PHOTO_SHOTS.find((s) => s.key === k)?.label || null;

/** The guided shots for a booking's service, in shooting order. */
export function shotsForBooking({ category, jobFlag }) {
  const scopes = checklistScopes(category, jobFlag);
  const areas = new Set();
  if (scopes.includes("interior")) areas.add("interior");
  if (scopes.includes("exterior") || scopes.includes("ceramic")) areas.add("exterior");
  if (!areas.size) { areas.add("interior"); areas.add("exterior"); } // unknown service: ask for everything
  return PHOTO_SHOTS.filter((s) => areas.has(s.area));
}

export function minPhotos() {
  const read = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return { before: read("JOB_MIN_BEFORE_PHOTOS", 2), after: read("JOB_MIN_AFTER_PHOTOS", 4) };
}

/** Checklist scopes for a service category + job flag. */
export function checklistScopes(category, jobFlag) {
  const c = String(category || "").toLowerCase();
  const scopes = ["general"];
  if (c.includes("interior")) scopes.push("interior");
  if (c.includes("exterior")) scopes.push("exterior");
  if (c.includes("combined") || c.includes("monthly") || c.includes("full")) {
    scopes.push("interior", "exterior");
  }
  if (jobFlag === "ceramic") scopes.push("ceramic");
  return [...new Set(scopes)];
}

const SCOPE_ORDER = { general: 0, interior: 1, exterior: 2, ceramic: 3 };

/** Steps that apply to this booking, in the order the crew should do them. */
export function stepsForBooking(allSteps, { category, level, jobFlag }) {
  const scopes = checklistScopes(category, jobFlag);
  const lvl = Number(level) || 1;
  return allSteps
    .filter((s) => s.active !== false && scopes.includes(s.scope) && (s.min_level || 1) <= lvl)
    .sort((a, b) => {
      // General opening steps first, general closing steps (order >= 90) last.
      const rank = (s) => (s.scope === "general" ? (s.step_order >= 90 ? 9 : -1) : SCOPE_ORDER[s.scope]);
      return rank(a) - rank(b) || a.step_order - b.step_order;
    });
}

/**
 * Everything still blocking completion, as plain-language messages. Empty = ready.
 * With `shots` (guided photos) every required shot needs a before and an after photo; a job
 * whose photos were taken before guided shots existed (photos with no shot) keeps the old
 * minimum-count rule for that kind so it can still be finished.
 */
export function completionProblems({ steps, checked = {}, photoCounts = {}, mins = minPhotos(), shots = null, photos = [] }) {
  const problems = [];
  const missing = steps.filter((s) => s.required && !checked[s.id]);
  if (missing.length) {
    problems.push(`${missing.length} checklist step${missing.length === 1 ? "" : "s"} not checked off`);
  }
  for (const kind of ["before", "after"]) {
    const ofKind = (photos || []).filter((p) => p.kind === kind);
    const legacy = ofKind.some((p) => !p.shot);
    if (shots && !legacy) {
      const taken = new Set(ofKind.map((p) => p.shot));
      const need = shots.filter((s) => !s.optional && !taken.has(s.key)).map((s) => s.label);
      if (need.length) problems.push(`${kind === "before" ? "Before" : "After"} photos still needed: ${need.join(", ")}`);
      continue;
    }
    const have = shots ? ofKind.length : photoCounts[kind] || 0;
    if (have < mins[kind]) {
      problems.push(`${mins[kind] - have} more ${kind} photo${mins[kind] - have === 1 ? "" : "s"} needed (minimum ${mins[kind]})`);
    }
  }
  return problems;
}

/** UTC [start, end) for a New York calendar date (YYYY-MM-DD), DST-safe. */
export function nyDayRange(dateStr, days = 1) {
  const start = DateTime.fromISO(dateStr, { zone: BUSINESS_TZ }).startOf("day");
  if (!start.isValid) throw new Error("Invalid date");
  return { startISO: start.toUTC().toISO(), endISO: start.plus({ days }).toUTC().toISO() };
}

export function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function photoPath(bookingId, kind, id, ext = "jpg") {
  return `jobs/${bookingId}/${kind}/${id}.${ext}`;
}

/** True when a client-supplied storage path really belongs to this booking + kind. */
export function isPathForJob(path, bookingId, kind) {
  const re = new RegExp(`^jobs/${bookingId}/${kind}/[0-9a-f-]{36}\\.(jpg|png|webp|heic)$`);
  return typeof path === "string" && re.test(path);
}

export const JOB_SELECT = `
  id, scheduled_start, scheduled_end, status, service_address, customer_notes, crew_notes, job_flag,
  total_price, travel_fee,
  customers:customer_id ( full_name, phone ),
  vehicles:vehicle_id ( vehicle_year, vehicle_make, vehicle_model, vehicle_size, license_plate ),
  service_variants:service_variant_id ( duration_minutes, services:service_id ( category, level ) )
`;

/** The fields a crew member sees for one job (no discounts, base price or customer email). */
export function crewJobView(b, extras = {}) {
  const svc = b.service_variants?.services || {};
  const v = b.vehicles || {};
  return {
    id: b.id,
    scheduled_start: b.scheduled_start,
    scheduled_end: b.scheduled_end,
    status: b.status,
    service_address: b.service_address,
    customer_name: b.customers?.full_name || "Customer",
    customer_phone: b.customers?.phone || null,
    vehicle: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(" ") || null,
    vehicle_size: v.vehicle_size || null,
    license_plate: v.license_plate || null,
    service_category: svc.category || null,
    service_level: svc.level || null,
    duration_minutes: b.service_variants?.duration_minutes || null,
    customer_notes: b.customer_notes || null,
    crew_notes: b.crew_notes || null,
    job_flag: b.job_flag || null,
    amount_to_collect: b.total_price != null ? Number(b.total_price) : null,
    ...extras,
  };
}

export async function loadChecklistSteps(sb) {
  const { data, error } = await sb
    .from("service_checklists")
    .select("id, scope, min_level, step_order, text, required, active")
    .eq("active", true)
    .order("step_order");
  if (error) throw error;
  return data || [];
}

export function countPhotos(photos) {
  const counts = { before: 0, after: 0, issue: 0 };
  for (const p of photos || []) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return counts;
}

/** Adds short-lived view URLs to photo rows. */
export async function withSignedUrls(sb, photos, seconds = 3600) {
  if (!photos?.length) return [];
  const { data, error } = await sb.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(photos.map((p) => p.storage_path), seconds);
  if (error) throw error;
  const byPath = new Map((data || []).map((d) => [d.path, d.signedUrl]));
  return photos.map((p) => ({ ...p, url: byPath.get(p.storage_path) || null }));
}
