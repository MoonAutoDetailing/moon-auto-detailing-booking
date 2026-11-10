/**
 * One-time repair of maintenance-plan cycles (Nov 2026).
 *
 * Before the cycle fix, member bookings were never linked to cycles, so cycles were marked
 * missed (and discounts reset) even when the member was serviced. This planner rebuilds each
 * active subscription's history from its real bookings:
 *   - cycle 0 (the anchor/first service) is recorded as completed
 *   - each cycle is matched to the member's booking inside its window, or within 7 days of it
 *   - matched past cycles → completed; matched future bookings → booked
 *   - unmatched past cycles → void (forgiven; the system caused the misses)
 *   - the current unbooked cycle is re-dated with the corrected date math
 *   - discount penalties cleared and counts recomputed
 *
 * Usage (dry run, writes report + SQL, touches nothing):
 *   node scripts/subscription-repair.js <snapshot.json> <today YYYY-MM-DD> <outDir>
 * The SQL is applied separately, only after the owner approves the report.
 */
import fs from "node:fs";
import path from "node:path";
import { computeCycleWindow, getEffectiveWindowEnd, toNYDate, addDays } from "../api/_subscriptions/lifecycle.js";

const NEAR_DAYS = 7;
const USABLE = ["completed", "confirmed", "pending", "reschedule_requested"];

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Same car? Plate match, or make/model equal allowing small typos ("escilade" ≈ "escalade"). */
export function sameVehicle(v1, v2) {
  if (!v1 || !v2) return false;
  if (v1.id === v2.id) return true;
  const p1 = (v1.plate_key || "").replace("NOTSURE", "");
  const p2 = (v2.plate_key || "").replace("NOTSURE", "");
  if (p1 && p2) return p1 === p2;
  const k1 = (v1.mm_key || "").replace(/[\s-]/g, "");
  const k2 = (v2.mm_key || "").replace(/[\s-]/g, "");
  if (!k1 || !k2) return false;
  return levenshtein(k1, k2) <= 2;
}

/** Distance in days from a date to a window (0 = inside). */
function distanceToWindow(day, start, end) {
  if (day < start) return daysBetween(day, start);
  if (day > end) return daysBetween(end, day);
  return 0;
}

export function planRepair(snapshot, today) {
  const vehicles = new Map(snapshot.vehicles.map((v) => [v.id, v]));
  const variants = new Map(snapshot.variants.map((v) => [v.id, v]));
  const plans = [];

  const liveSubsByCustomer = new Map();
  for (const s of snapshot.subscriptions) {
    if (s.status === "cancelled") continue;
    liveSubsByCustomer.set(s.customer_id, (liveSubsByCustomer.get(s.customer_id) || 0) + 1);
  }

  for (const sub of snapshot.subscriptions) {
    if (sub.status !== "active" || !sub.anchor_date) continue;
    const subVehicle = vehicles.get(sub.vehicle_id);
    const multi = (liveSubsByCustomer.get(sub.customer_id) || 0) > 1;

    const bookings = snapshot.bookings
      .filter((b) => b.customer_id === sub.customer_id && USABLE.includes(b.status))
      .filter((b) => !multi || sameVehicle(vehicles.get(b.vehicle_id), subVehicle))
      .map((b) => ({ ...b, day: toNYDate(b.scheduled_start) }));

    const existing = snapshot.cycles
      .filter((c) => c.subscription_id === sub.id)
      .sort((a, b) => a.cycle_index - b.cycle_index);
    const cycles = [
      { id: null, cycle_index: 0, status: "(none)", window_start_date: sub.anchor_date, window_end_date: sub.anchor_date, virtual: true },
      ...existing
    ];

    // Greedy one-to-one matching, closest first.
    const pairs = [];
    for (const c of cycles) {
      const end = getEffectiveWindowEnd(c);
      for (const b of bookings) {
        const d = distanceToWindow(b.day, c.window_start_date, end);
        if (d <= NEAR_DAYS) pairs.push({ c, b, d });
      }
    }
    pairs.sort((x, y) => x.d - y.d || Math.abs(daysBetween(x.c.window_start_date, x.b.day)) - Math.abs(daysBetween(y.c.window_start_date, y.b.day)));
    const matchByCycle = new Map();
    const usedBookings = new Set();
    for (const p of pairs) {
      if (matchByCycle.has(p.c.cycle_index) || usedBookings.has(p.b.id)) continue;
      matchByCycle.set(p.c.cycle_index, p);
      usedBookings.add(p.b.id);
    }

    const rows = [];
    const lastIndex = existing.length ? existing[existing.length - 1].cycle_index : 0;
    for (const c of cycles) {
      const m = matchByCycle.get(c.cycle_index);
      const effEnd = getEffectiveWindowEnd(c);
      const isCurrent = !c.virtual && c.cycle_index === lastIndex && (c.status === "open" || c.status === "booked");
      const row = {
        cycle_id: c.id,
        cycle_index: c.cycle_index,
        before: { status: c.status, start: c.window_start_date, end: effEnd },
        after: {},
        booking: m ? { id: m.b.id, day: m.b.day, status: m.b.status, base_price: m.b.base_price, match: m.d === 0 ? "in window" : `${m.d} day(s) outside` } : null,
        notes: []
      };

      if (c.virtual) {
        row.after = { status: "completed", start: sub.anchor_date, end: sub.anchor_date };
        row.notes.push("First service (anchor) recorded as completed cycle 1 of the commitment");
        if (!m) row.notes.push("No booking found on the anchor date; recorded without a linked booking");
      } else if (m) {
        const bookingFuture = m.b.day >= today && m.b.status !== "completed";
        if (bookingFuture) {
          row.after = { status: "booked" };
          row.notes.push("Upcoming appointment attached to this cycle");
        } else {
          row.after = { status: "completed" };
          if (m.b.status !== "completed") row.notes.push(`Appointment date has passed but booking is still "${m.b.status}" in admin — please mark it completed`);
        }
      } else if (effEnd < today) {
        row.after = { status: "void" };
        row.notes.push(c.status === "missed" ? "Miss forgiven (no booking found; system was broken)" : "Past window with no booking — forgiven");
      } else {
        const win = computeCycleWindow(sub.anchor_date, sub.frequency, c.cycle_index, 0);
        // Existing open cycles were already announced by email: never shorten the window a
        // member was told about.
        if (c.window_end_date > win.end) win.end = c.window_end_date;
        row.after = { status: "open", start: win.start, end: win.end, opens_on: win.opensOn };
        if (c.pushback_used && !c.free_pushback) {
          row.after.free_pushback = true;
          row.notes.push(`Pushback to ${c.pushback_end_date} kept, 15% fee waived`);
        }
        if (win.start !== c.window_start_date || win.end !== c.window_end_date) {
          row.notes.push(`Window corrected ${c.window_start_date}–${c.window_end_date} → ${win.start}–${win.end}`);
        }
        row.notes.push(today >= win.opensOn ? "Open now; member will get one accurate \"book now\" email when automation is turned back on" : `Booking opens ${win.opensOn}`);
      }
      if (m) {
        const full = Number(variants.get(m.b.service_variant_id)?.price);
        row.price_mode = c.virtual ? "full" : (Number.isFinite(full) && Number(m.b.base_price) < full ? "discounted" : "full");
      }
      if (!isCurrent && row.after.status === "open") row.after.status = "void";
      rows.push(row);
    }

    const unmatched = bookings
      .filter((b) => !usedBookings.has(b.id) && b.day >= addDays(sub.anchor_date, -NEAR_DAYS))
      .map((b) => ({ id: b.id, day: b.day, status: b.status }));

    const completed = rows.filter((r) => r.after.status === "completed").length;
    plans.push({
      subscription: sub,
      vehicle: subVehicle?.mm_key || "",
      rows,
      unmatched,
      subscriptionAfter: { discount_reset_required: false, completed_cycles_count: completed, missed_cycles_count: 0 },
      subscriptionBefore: { discount_reset_required: sub.discount_reset_required, completed_cycles_count: sub.completed_cycles_count, missed_cycles_count: sub.missed_cycles_count }
    });
  }
  return plans;
}

const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

export function toSql(plans) {
  const out = ["begin;"];
  for (const p of plans) {
    const sid = p.subscription.id;
    for (const r of p.rows) {
      const a = r.after;
      if (r.cycle_index === 0) {
        out.push(`with c0 as (insert into public.subscription_cycles (subscription_id, cycle_index, status, window_start_date, window_end_date, opens_on, pushback_used, completed_at, resolved_by)
  values (${q(sid)}, 0, 'completed', ${q(a.start)}, ${q(a.end)}, ${q(a.start)}, false, now(), 'repair') returning id)
${r.booking ? `insert into public.subscription_cycle_bookings (cycle_id, booking_id, price_mode, pushback_fee_applied) select id, ${q(r.booking.id)}, 'full', false from c0;` : "select 1 from c0;"}`);
        continue;
      }
      const sets = [`status = ${q(a.status)}`, `resolved_by = 'repair'`];
      if (a.status === "completed") sets.push("completed_at = now()");
      if (a.start) sets.push(`window_start_date = ${q(a.start)}`, `window_end_date = ${q(a.end)}`, `opens_on = ${q(a.opens_on)}`);
      if (a.free_pushback) sets.push("free_pushback = true");
      out.push(`update public.subscription_cycles set ${sets.join(", ")} where id = ${q(r.cycle_id)};`);
      if (r.booking) {
        out.push(`insert into public.subscription_cycle_bookings (cycle_id, booking_id, price_mode, pushback_fee_applied) values (${q(r.cycle_id)}, ${q(r.booking.id)}, ${q(r.price_mode)}, false);`);
      }
      out.push(`insert into public.subscription_cycle_audit (subscription_id, cycle_id, booking_id, action, actor, before, after, notes) values (${q(sid)}, ${q(r.cycle_id)}, ${q(r.booking?.id)}, 'repair', 'repair-2026-11', ${q(JSON.stringify(r.before))}::jsonb, ${q(JSON.stringify(r.after))}::jsonb, ${q(r.notes.join("; "))});`);
    }
    const s = p.subscriptionAfter;
    out.push(`update public.subscriptions set discount_reset_required = false, completed_cycles_count = ${s.completed_cycles_count}, missed_cycles_count = 0 where id = ${q(sid)};`);
    out.push(`insert into public.subscription_cycle_audit (subscription_id, action, actor, before, after) values (${q(sid)}, 'repair_subscription', 'repair-2026-11', ${q(JSON.stringify(p.subscriptionBefore))}::jsonb, ${q(JSON.stringify(s))}::jsonb);`);
  }
  out.push("commit;");
  return out.join("\n");
}

const LABEL = { completed: "Completed", booked: "Booked", open: "Open", void: "Forgiven", missed: "Missed", "(none)": "—" };

export function toMarkdown(plans, today) {
  const lines = [`# Maintenance plan repair — proposed changes (as of ${today})`, ""];
  plans.forEach((p, i) => {
    const s = p.subscription;
    lines.push(`## Member ${i + 1} — ${s.frequency}, ${p.vehicle}, anchor ${s.anchor_date}`);
    lines.push(`Discount penalty: ${p.subscriptionBefore.discount_reset_required ? "**on → off**" : "off"} · Completed cycles: ${p.subscriptionBefore.completed_cycles_count} → **${p.subscriptionAfter.completed_cycles_count}** · Missed: ${p.rows.filter((r) => r.before.status === "missed").length} → **0**`, "");
    lines.push("| Cycle | Window | Before | After | Matched booking | Notes |", "|---|---|---|---|---|---|");
    for (const r of p.rows) {
      const win = r.after.start && r.after.start !== r.before.start ? `${r.after.start} – ${r.after.end}` : `${r.before.start} – ${r.before.end}`;
      const b = r.booking ? `${r.booking.day} (${r.booking.status}, ${r.booking.match})` : "—";
      lines.push(`| ${r.cycle_index + 1} | ${win} | ${LABEL[r.before.status] || r.before.status} | **${LABEL[r.after.status]}** | ${b} | ${r.notes.join("; ")} |`);
    }
    if (p.unmatched.length) lines.push("", `Bookings not tied to any cycle: ${p.unmatched.map((u) => `${u.day} (${u.status})`).join(", ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function toCsv(plans) {
  const rows = [["member", "frequency", "vehicle", "cycle", "before_status", "after_status", "before_window", "after_window", "booking_date", "booking_status", "match", "notes"]];
  plans.forEach((p, i) => {
    for (const r of p.rows) {
      rows.push([i + 1, p.subscription.frequency, p.vehicle, r.cycle_index + 1, r.before.status, r.after.status,
        `${r.before.start}..${r.before.end}`, r.after.start ? `${r.after.start}..${r.after.end}` : "",
        r.booking?.day || "", r.booking?.status || "", r.booking?.match || "", r.notes.join("; ")]);
    }
  });
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("subscription-repair.js")) {
  const [snapshotPath, today, outDir] = process.argv.slice(2);
  if (!snapshotPath || !today || !outDir) {
    console.error("Usage: node scripts/subscription-repair.js <snapshot.json> <YYYY-MM-DD> <outDir>");
    process.exit(1);
  }
  const plans = planRepair(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), today);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "repair-report.md"), toMarkdown(plans, today));
  fs.writeFileSync(path.join(outDir, "repair-report.csv"), toCsv(plans));
  fs.writeFileSync(path.join(outDir, "repair-apply.sql"), toSql(plans));
  console.log(`Planned ${plans.length} subscriptions → ${outDir}`);
}
