-- Bookkeeping: job payments + expenses
-- Adds two new tables. No changes to existing tables.
-- Requires: public.bookings exists.

-- ============================================================================
-- job_payments: one row per completed booking, captured when admin clicks Complete.
-- One-to-one with bookings via unique(booking_id).
-- ============================================================================
create table if not exists public.job_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  amount_collected numeric(10,2) not null check (amount_collected >= 0),
  tip_amount numeric(10,2) not null default 0 check (tip_amount >= 0),
  payment_method text not null check (payment_method in ('Cash','PayPal','Venmo','Check')),
  notes text,
  recorded_at timestamptz not null default now(),
  recorded_by text
);

create unique index if not exists job_payments_booking_id_idx
  on public.job_payments (booking_id);

create index if not exists job_payments_recorded_at_idx
  on public.job_payments (recorded_at);

-- ============================================================================
-- expenses: business expenses logged by admin.
-- Independent of bookings.
-- ============================================================================
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  vendor text not null,
  category text not null,
  expense_type text not null check (expense_type in (
    'Direct Cost',
    'Operating Expense',
    'Asset Purchase',
    'Owner Draw',
    'Owner Contribution',
    'Liability Payment'
  )),
  description text,
  amount numeric(10,2) not null check (amount >= 0),
  payment_method text not null check (payment_method in (
    'Cash','PayPal','Venmo','Check','Credit Card','Bank Transfer','Other'
  )),
  receipt_saved boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists expenses_expense_date_idx
  on public.expenses (expense_date);

create index if not exists expenses_expense_type_idx
  on public.expenses (expense_type);
