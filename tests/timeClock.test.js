// Time clock rules: geofence, pay weeks, hour totals/overtime/flags, and entry edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineMeters,
  checkGeofence,
  payWeek,
  minutesWithin,
  summarizeWeek,
  parseEntryEdit,
} from "../api/_timeclock.js";

const job = { label: "Job", lat: 40.7128, lng: -74.006 };
// ~0.0036° latitude ≈ 400 m
const north = (m) => ({ lat: job.lat + m / 111195, lng: job.lng });

test("haversine distance is accurate at local scale", () => {
  assert.ok(Math.abs(haversineMeters(job, north(1000)) - 1000) < 2);
  assert.equal(haversineMeters(job, job), 0);
});

test("geofence: inside radius, GPS error credited up to 150 m, nearest site reported", () => {
  assert.equal(checkGeofence({ ...north(350) }, [job], 400).ok, true);
  assert.equal(checkGeofence({ ...north(500) }, [job], 400).ok, false);
  assert.equal(checkGeofence({ ...north(500), accuracy: 120 }, [job], 400).ok, true);
  // Accuracy credit is capped: a 2 km fuzzy fix 1 km away doesn't pass.
  assert.equal(checkGeofence({ ...north(1000), accuracy: 2000 }, [job], 400).ok, false);

  const base = { label: "Base", lat: 40.60, lng: -74.10 };
  const r = checkGeofence({ ...north(5000) }, [base, job], 400);
  assert.equal(r.ok, false);
  assert.equal(r.nearest.label, "Job");
  assert.ok(Math.abs(r.nearest.distanceM - 5000) < 5);
});

test("geofence fails safely without a position or sites", () => {
  assert.deepEqual(checkGeofence(null, [job]), { ok: false, nearest: null });
  assert.deepEqual(checkGeofence({ lat: 40, lng: -74 }, []), { ok: false, nearest: null });
  assert.equal(checkGeofence({ lat: "x", lng: -74 }, [job]).ok, false);
});

test("pay weeks run Monday–Sunday in New York time, across DST", () => {
  // Wed Nov 11 2026
  assert.deepEqual(payWeek("2026-11-11"), {
    weekStart: "2026-11-09",
    weekEnd: "2026-11-15",
    startISO: "2026-11-09T05:00:00.000Z",
    endISO: "2026-11-16T05:00:00.000Z",
  });
  // Sunday belongs to the week that started the Monday before.
  assert.equal(payWeek("2026-11-15").weekStart, "2026-11-09");
  // Week containing the Nov 1 fall-back starts at EDT and ends at EST.
  const dst = payWeek("2026-11-01");
  assert.equal(dst.weekStart, "2026-10-26");
  assert.equal(dst.startISO, "2026-10-26T04:00:00.000Z");
  assert.equal(dst.endISO, "2026-11-02T05:00:00.000Z");
});

test("minutes are clipped to the week and open entries run until now", () => {
  const week = payWeek("2026-11-11");
  // Sunday-night shift crossing into the next week only counts its in-week part.
  const crossing = { clock_in_at: "2026-11-16T03:00:00Z", clock_out_at: "2026-11-16T07:00:00Z" };
  assert.equal(minutesWithin(crossing, week.startISO, week.endISO), 120);
  const open = { clock_in_at: "2026-11-11T13:00:00Z", clock_out_at: null };
  assert.equal(minutesWithin(open, week.startISO, week.endISO, new Date("2026-11-11T15:30:00Z")), 150);
});

function day(n, startHourUtc, hours, extra = {}) {
  const inAt = new Date(Date.UTC(2026, 10, 9 + n, startHourUtc));
  return { id: `e${n}`, clock_in_at: inAt.toISOString(), clock_out_at: new Date(inAt.getTime() + hours * 3600000).toISOString(), verify_method: "gps", ...extra };
}

test("weekly totals split regular and overtime at 40 hours", () => {
  const week = payWeek("2026-11-11");
  const settings = { weeklyOvertimeHours: 40, overtimeMultiplier: 1.5, radiusM: 400 };
  const s = summarizeWeek([0, 1, 2, 3, 4].map((n) => day(n, 13, 9)), week, { settings, now: new Date("2026-11-20T00:00:00Z") });
  assert.equal(s.hours, 45);
  assert.equal(s.regularHours, 40);
  assert.equal(s.overtimeHours, 5);
  assert.ok(s.flags.some((f) => f.type === "overtime"));
  assert.equal(s.open, false);
});

test("voided entries don't count; long shifts, forgotten clock-outs and PIN clock-ins are flagged", () => {
  const week = payWeek("2026-11-11");
  const now = new Date("2026-11-12T06:00:00Z");
  const s = summarizeWeek(
    [
      day(0, 13, 8, { voided_at: "2026-11-10T00:00:00Z" }),
      day(1, 12, 13),
      day(2, 13, 4, { verify_method: "pin" }),
      { id: "open", clock_in_at: "2026-11-11T13:00:00Z", clock_out_at: null, verify_method: "gps" },
    ],
    week,
    { now }
  );
  assert.equal(s.hours, 13 + 4 + 17);
  assert.equal(s.open, true);
  const types = s.flags.map((f) => `${f.entry_id}:${f.type}`).sort();
  assert.deepEqual(types, ["e1:long_shift", "e2:pin_clock_in", "open:forgot_clock_out"]);
});

test("entry edits are validated", () => {
  assert.deepEqual(parseEntryEdit({ clock_in_at: "2026-11-10T13:00:00Z", clock_out_at: "2026-11-10T21:00:00Z" }).update, {
    clock_in_at: "2026-11-10T13:00:00.000Z",
    clock_out_at: "2026-11-10T21:00:00.000Z",
  });
  assert.match(parseEntryEdit({ clock_in_at: "2026-11-10T13:00:00Z", clock_out_at: "2026-11-10T12:00:00Z" }).error, /after clock-in/);
  assert.match(parseEntryEdit({ clock_in_at: "2026-11-10T13:00:00Z", clock_out_at: "2026-11-11T14:00:00Z" }).error, /24 hours/);
  assert.match(parseEntryEdit({ clock_in_at: "garbage" }).error, /Invalid clock in at/);
  assert.match(parseEntryEdit({}).error, /required/);
  assert.match(parseEntryEdit({ clock_in_at: new Date(Date.now() + 3600000).toISOString() }).error, /future/);
  // Editing only the clock-out is checked against the stored clock-in.
  const existing = { clock_in_at: "2026-11-10T13:00:00Z", clock_out_at: null };
  assert.match(parseEntryEdit({ clock_out_at: "2026-11-10T12:00:00Z" }, existing).error, /after clock-in/);
  assert.deepEqual(parseEntryEdit({ clock_out_at: null }, existing).update, { clock_out_at: null });
});
