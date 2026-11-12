-- Approval hierarchy, password reset and team-coverage sync (all additive).
--
-- Expenses: managers approve employee receipts; the owner approves managers' own receipts and
-- signs off each week's expense report (expenses entered Monday–Sunday, New York time).
alter table public.expenses
  add column if not exists owner_reviewed_at timestamptz,
  add column if not exists owner_reviewed_by text;

create table if not exists public.expense_reports (
  week_start date primary key,
  week_end date not null,
  status text not null default 'approved' check (status in ('approved')),
  expense_count integer not null default 0,
  total numeric(10, 2) not null default 0,
  approved_by text,
  approved_at timestamptz not null default now()
);
alter table public.expense_reports enable row level security;

-- Payroll: a manager signs off the crew's pay; weeks that include a manager's (or owner's)
-- pay are finished by the owner.
alter table public.payroll_runs
  add column if not exists crew_approved_by text,
  add column if not exists crew_approved_at timestamptz;

-- Forgot password: one-hour, single-use reset link (only a SHA-256 of the token is stored).
alter table public.staff
  add column if not exists reset_token_hash text,
  add column if not exists reset_expires_at timestamptz;
create index if not exists idx_staff_reset_token on public.staff (reset_token_hash) where reset_token_hash is not null;

-- Booking availability follows team availability: rows written by the sync are 'auto' and are
-- added/removed by it; anything set by hand on the Availability screen is 'manual' and wins.
alter table public.staffing_overrides
  add column if not exists source text not null default 'manual' check (source in ('manual', 'auto'));
alter table public.availability_overrides
  add column if not exists source text not null default 'manual' check (source in ('manual', 'auto'));
