# Phase 5 Manage-Subscription Portal — Smoke Test Data Plan

**Purpose:** Manual SQL to drive one existing active subscription through states A → F for portal verification. No production code changes. Test data only.

**Important:** The app uses these column names. If your Supabase schema differs (e.g. only Phase 4 migration with `cycle_sequence`, `cycle_start_date`, `cycle_end_date`), add or rename columns to match: `subscription_cycles` uses `cycle_index`, `window_start_date`, `window_end_date`, `pushback_used`, `pushback_end_date`, `free_pushback`. The link table uses `price_mode`, `pushback_fee_applied`, `pushback_fee_amount`.

---

## 1. Prerequisites: Pick your base subscription

Run in Supabase SQL and keep the result for the rest of the steps:

```sql
-- Run once: get one active subscription and its portal token
SELECT
  s.id AS sub_id,
  s.activation_booking_id,
  s.anchor_date,
  s.frequency,
  s.completed_cycles_count,
  s.missed_cycles_count,
  b.manage_token AS portal_token,
  b.customer_id,
  b.vehicle_id,
  b.service_variant_id
FROM subscriptions s
JOIN bookings b ON b.id = s.activation_booking_id
WHERE s.status = 'active'
  AND b.manage_token IS NOT NULL
LIMIT 1;
```

Use:
- `sub_id` → **:sub_id** in the SQL below
- `activation_booking_id` → **:activation_booking_id**
- `portal_token` → open portal as `manage-subscription.html?token=<portal_token>`
- `customer_id`, `vehicle_id`, `service_variant_id` → for inserting test bookings

---

## 2. SQL blocks (run in order; reversible where noted)

Replace `:sub_id`, `:activation_booking_id`, and any `:customer_id`, `:vehicle_id`, `:service_variant_id` with the values from the query above (paste the actual UUIDs/values; Supabase SQL does not use named parameters). For new bookings use the same customer/vehicle/service_variant as the subscription. Where a block returns an id (e.g. STATE D and E), run the INSERT...RETURNING, note the id, then substitute that into the following statements in the same block.

---

### STATE A — Active subscription, no active cycle

**Goal:** No row in `subscription_cycles` with `status` in ('open','booked') for this subscription. Portal shows “No active cycle right now.”

```sql
-- ---------- STATE A ----------
-- Clean any open/booked cycle so “no active cycle” (reversible: we add one in B)
DELETE FROM subscription_cycle_bookings
WHERE cycle_id IN (
  SELECT id FROM subscription_cycles
  WHERE subscription_id = :sub_id AND status IN ('open', 'booked')
);

UPDATE subscription_cycles
SET status = 'missed'
WHERE subscription_id = :sub_id AND status IN ('open', 'booked');

-- Optional: ensure subscription is active and counts are consistent
UPDATE subscriptions
SET status = 'active',
    completed_cycles_count = COALESCE(completed_cycles_count, 0),
    missed_cycles_count = COALESCE(missed_cycles_count, 0)
WHERE id = :sub_id;
```

**Inspect after STATE A:**

| Where | Fields to check |
|-------|------------------|
| `subscriptions` | `id = :sub_id`, `status = 'active'` |
| `subscription_cycles` | No row with `subscription_id = :sub_id` and `status` in ('open','booked') |

**Portal checks:**

- Open `manage-subscription.html?token=<portal_token>`.
- Subscription status: Active.
- Current cycle: “No active cycle right now. Check back when your next window opens.”
- Cycle history: may show past cycles or “No cycle history yet.”
- Cancel: may be hidden if `completed_cycles_count < 3`.

---

### STATE B — Active subscription, one open cycle, no linked booking

**Goal:** One cycle `status = 'open'`, no row in `subscription_cycle_bookings` for that cycle. Portal shows current cycle card, pushback button, booking CTA.

```sql
-- ---------- STATE B ----------
-- Ensure we have exactly one open cycle (no other open/booked)
DELETE FROM subscription_cycle_bookings
WHERE cycle_id IN (
  SELECT id FROM subscription_cycles
  WHERE subscription_id = :sub_id AND status IN ('open', 'booked')
);
UPDATE subscription_cycles
SET status = 'missed'
WHERE subscription_id = :sub_id AND status IN ('open', 'booked');

-- Insert one open cycle (window_end_date = anchor_date + 5 days for simplicity)
INSERT INTO subscription_cycles (
  subscription_id,
  status,
  cycle_index,
  window_start_date,
  window_end_date,
  pushback_used,
  free_pushback
)
SELECT
  s.id,
  'open',
  COALESCE((SELECT MAX(c.cycle_index) FROM subscription_cycles c WHERE c.subscription_id = s.id), 0) + 1,
  s.anchor_date,
  s.anchor_date + 5,
  false,
  false
FROM subscriptions s
WHERE s.id = :sub_id;
```

If your schema uses `cycle_sequence` instead of `cycle_index`, replace `cycle_index` with `cycle_sequence` in all blocks. If it uses `cycle_start_date`/`cycle_end_date`, replace `window_start_date`/`window_end_date`.

**Inspect after STATE B:**

| Where | Fields to check |
|-------|------------------|
| `subscription_cycles` | One row: `subscription_id = :sub_id`, `status = 'open'`, `pushback_used = false`. Note `id` → **:cycle_id_b** for later. |
| `subscription_cycle_bookings` | No row for this `cycle_id`. |

**Portal checks:**

- Current cycle card visible with window dates and “Book by” date.
- “Push back window” button visible.
- “Continue to booking form” / booking CTA visible.
- No booking card yet.

---

### STATE C — Same subscription, same cycle pushed back, no booking

**Goal:** Same cycle as B with `pushback_used = true` and `pushback_end_date` set. No link in `subscription_cycle_bookings`. Portal shows pushback state and no pushback button.

```sql
-- ---------- STATE C ----------
-- Use the cycle id from STATE B (:cycle_id_b)
UPDATE subscription_cycles
SET
  pushback_used = true,
  pushback_end_date = window_end_date + 5
WHERE id = :cycle_id_b
  AND subscription_id = :sub_id
  AND status = 'open';
-- If pushback_end_date must be business days, set explicitly, e.g. window_end_date + 7 to approximate 5 business days.
```

**Inspect after STATE C:**

| Where | Fields to check |
|-------|------------------|
| `subscription_cycles` | Same row: `pushback_used = true`, `pushback_end_date` set, `status = 'open'`. |
| `subscription_cycle_bookings` | Still no row for this cycle. |

**Portal checks:**

- “Pushback already used for this cycle” (or similar) and new deadline (effective booking deadline) shown.
- “Push back window” button gone.
- Booking CTA still visible (cycle still open, no booking).

---

### STATE D — Same subscription, cycle booked, linked booking, no pushback fee

**Goal:** A *different* cycle than C (because the one in C is already pushed and would get a fee if we booked it). So: resolve the cycle from B/C (e.g. mark missed), add one new open cycle, create a booking and link it with `pushback_fee_applied = false`.

```sql
-- ---------- STATE D ----------
-- 1) Resolve the cycle from B/C (so we can have one new open cycle)
UPDATE subscription_cycles
SET status = 'missed'
WHERE id = :cycle_id_b AND subscription_id = :sub_id;

UPDATE subscriptions
SET missed_cycles_count = COALESCE(missed_cycles_count, 0) + 1
WHERE id = :sub_id;

-- 2) Insert one new open cycle (no pushback)
INSERT INTO subscription_cycles (
  subscription_id,
  status,
  cycle_index,
  window_start_date,
  window_end_date,
  pushback_used,
  free_pushback
)
SELECT
  s.id,
  'open',
  COALESCE((SELECT MAX(c.cycle_index) FROM subscription_cycles c WHERE c.subscription_id = s.id), 0) + 1,
  s.anchor_date,
  s.anchor_date + 5,
  false,
  false
FROM subscriptions s
WHERE s.id = :sub_id;

-- 3) Create a test booking and link it (no pushback fee)
-- Replace :customer_id, :vehicle_id, :service_variant_id with values from prerequisite query.
INSERT INTO bookings (
  customer_id,
  vehicle_id,
  service_variant_id,
  service_address,
  scheduled_start,
  scheduled_end,
  status,
  manage_token,
  travel_minutes,
  travel_fee,
  base_price,
  total_price
)
SELECT
  :customer_id,
  :vehicle_id,
  :service_variant_id,
  s.default_address,
  (c.window_start_date || 'T18:00:00')::timestamptz,
  (c.window_start_date || 'T19:00:00')::timestamptz,
  'pending',
  gen_random_uuid(),
  15,
  10.00,
  100.00,
  110.00
FROM subscriptions s
JOIN subscription_cycles c ON c.subscription_id = s.id AND c.status = 'open'
WHERE s.id = :sub_id
LIMIT 1
RETURNING id;
-- Use returned booking id in the next two statements (run in one transaction or note id).

-- 4a) Link cycle to booking (use the booking id from step 3)
INSERT INTO subscription_cycle_bookings (cycle_id, booking_id, price_mode, pushback_fee_applied, pushback_fee_amount)
SELECT c.id, :booking_id_d, 'discounted', false, NULL
FROM subscription_cycles c
WHERE c.subscription_id = :sub_id AND c.status = 'open'
LIMIT 1;

-- 4b) Mark cycle as booked
UPDATE subscription_cycles
SET status = 'booked'
WHERE subscription_id = :sub_id AND status = 'open';
```

**Inspect after STATE D:**

| Where | Fields to check |
|-------|------------------|
| `subscription_cycles` | One row with `status = 'booked'`, `pushback_used = false`. |
| `subscription_cycle_bookings` | One row: that `cycle_id`, `booking_id = :booking_id_d`, `pushback_fee_applied = false`, `pushback_fee_amount` NULL. |
| `bookings` | Row `id = :booking_id_d` with `base_price`, `total_price` set. |

**Portal checks:**

- Booking card visible (date, time, address, “Manage this booking” if `manage_token` set).
- Pricing: Service + Travel; “Pushback fee” shows “Not applied”; total = subtotal (no pushback).

---

### STATE E — Same subscription, cycle booked with pushback fee

**Goal:** Complete the cycle from D, then one new open cycle, apply pushback, create a booking and link with `pushback_fee_applied = true` and `pushback_fee_amount` set (e.g. 15% of base).

```sql
-- ---------- STATE E ----------
-- 1) Complete the cycle from D (and increment completed_cycles_count)
UPDATE subscription_cycles
SET status = 'completed'
WHERE subscription_id = :sub_id AND status = 'booked';

UPDATE subscriptions
SET completed_cycles_count = COALESCE(completed_cycles_count, 0) + 1
WHERE id = :sub_id;

-- 2) New open cycle
INSERT INTO subscription_cycles (
  subscription_id,
  status,
  cycle_index,
  window_start_date,
  window_end_date,
  pushback_used,
  free_pushback
)
SELECT
  s.id,
  'open',
  COALESCE((SELECT MAX(c.cycle_index) FROM subscription_cycles c WHERE c.subscription_id = s.id), 0) + 1,
  s.anchor_date,
  s.anchor_date + 5,
  false,
  false
FROM subscriptions s
WHERE s.id = :sub_id;

-- 3) Apply pushback to this new cycle
UPDATE subscription_cycles
SET pushback_used = true,
    pushback_end_date = window_end_date + 5
WHERE subscription_id = :sub_id AND status = 'open';

-- 4a) Create booking (15% pushback fee: base 100 -> fee 15, total 125)
INSERT INTO bookings (
  customer_id,
  vehicle_id,
  service_variant_id,
  service_address,
  scheduled_start,
  scheduled_end,
  status,
  manage_token,
  travel_minutes,
  travel_fee,
  base_price,
  total_price
)
SELECT
  :customer_id,
  :vehicle_id,
  :service_variant_id,
  s.default_address,
  (c.window_start_date || 'T18:00:00')::timestamptz,
  (c.window_start_date || 'T19:00:00')::timestamptz,
  'pending',
  gen_random_uuid(),
  15,
  10.00,
  100.00,
  125.00
FROM subscriptions s
JOIN subscription_cycles c ON c.subscription_id = s.id AND c.status = 'open'
WHERE s.id = :sub_id
LIMIT 1
RETURNING id;
-- Use returned id as :booking_id_e in 4b.

-- 4b) Link cycle to booking with pushback fee; then mark cycle booked
INSERT INTO subscription_cycle_bookings (cycle_id, booking_id, price_mode, pushback_fee_applied, pushback_fee_amount)
SELECT c.id, :booking_id_e, 'discounted', true, 15.00
FROM subscription_cycles c
WHERE c.subscription_id = :sub_id AND c.status = 'open'
LIMIT 1;

UPDATE subscription_cycles
SET status = 'booked'
WHERE subscription_id = :sub_id AND status = 'open';
```

**Inspect after STATE E:**

| Where | Fields to check |
|-------|------------------|
| `subscription_cycles` | One `booked` cycle with `pushback_used = true`, `pushback_end_date` set. |
| `subscription_cycle_bookings` | New row: `pushback_fee_applied = true`, `pushback_fee_amount = 15.00`. |
| `bookings` | New booking with `total_price` including fee (e.g. 125.00). |

**Portal checks:**

- Booking card visible.
- Pushback fee row shows “Applied” and amount (e.g. $15.00).
- Total = base + travel + pushback fee (authoritative total).

---

### STATE F — Same subscription cancelled

**Goal:** Subscription `status = 'cancelled'`. Portal shows cancelled status; cancel action gone or disabled.

```sql
-- ---------- STATE F ----------
-- Allow cancel: need completed_cycles_count >= 3 (if not already)
UPDATE subscriptions
SET completed_cycles_count = GREATEST(COALESCE(completed_cycles_count, 0), 3)
WHERE id = :sub_id;

UPDATE subscriptions
SET status = 'cancelled'
WHERE id = :sub_id;
```

**Inspect after STATE F:**

| Where | Fields to check |
|-------|------------------|
| `subscriptions` | `status = 'cancelled'`. |

**Portal checks:**

- Subscription status badge: “Cancelled”.
- Cancel subscription button gone or disabled.
- Rest of portal (cycle history, last cycle/booking if any) still readable.

---

## 3. Verification checklist summary

| State | Key DB state | Portal checks |
|-------|--------------|----------------|
| A | No open/booked cycle | “No active cycle”; no pushback/book buttons. |
| B | One open cycle, no link | Cycle card; pushback button; booking CTA. |
| C | Same cycle pushback_used, no link | Pushback message + new deadline; no pushback button. |
| D | New open→booked cycle, link, no fee | Booking card; pricing; “Pushback fee: Not applied.” |
| E | New cycle pushback then booked, link + fee | Booking card; “Pushback fee: Applied”; correct total. |
| F | Subscription cancelled | “Cancelled”; cancel action gone/disabled. |

---

## 4. Risks and order

- **Order:** Run A → B → C → D → E → F. Reversing (e.g. running D before C) can leave two unresolved cycles or a cycle with no matching link.
- **Unique constraint:** At most one `subscription_cycles` row per subscription with `status` in ('open','booked'). Adding a second open cycle without resolving the first will fail.
- **One booking per cycle:** `subscription_cycle_bookings` has `UNIQUE(cycle_id)`. Only one link per cycle.
- **Token:** Portal always uses the **activation** booking’s `manage_token` (from the prerequisite query), not the cycle booking’s token.
- **IDs:** Where the SQL says “note :cycle_id_b” or “:booking_id_d”, run the block, then read the `id` from the inserted/updated row and use it in the next block if required (e.g. STATE D uses the cycle created in the same block; STATE E uses the current open cycle).

---

## 5. Column name reference (from code)

- **subscription_cycles:** `id`, `subscription_id`, `status`, `cycle_index`, `window_start_date`, `window_end_date`, `pushback_used`, `pushback_end_date`, `free_pushback`
- **subscription_cycle_bookings:** `cycle_id`, `booking_id`, `price_mode`, `pushback_fee_applied`, `pushback_fee_amount`
- **subscriptions:** `id`, `status`, `activation_booking_id`, `anchor_date`, `frequency`, `completed_cycles_count`, `missed_cycles_count`, `default_address`
- **bookings:** `id`, `manage_token`, `customer_id`, `vehicle_id`, `service_variant_id`, `service_address`, `scheduled_start`, `scheduled_end`, `status`, `base_price`, `travel_fee`, `total_price`, `travel_minutes`

If your DB uses different names (e.g. from an older migration), adjust the SQL to match your schema.
