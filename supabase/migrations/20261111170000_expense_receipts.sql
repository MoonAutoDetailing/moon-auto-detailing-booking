-- Receipt-backed expenses. The crew submits expenses with a receipt photo; a manager
-- approves or rejects them. Only approved expenses count in totals and bookkeeping.
-- Existing rows become 'approved' so current books are unchanged.

alter table public.expenses
  add column if not exists receipt_path text,
  add column if not exists submitted_by_staff_id uuid references public.staff (id),
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected')),
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists reimburse boolean not null default false,
  add column if not exists reimbursed_at timestamptz;

create index if not exists idx_expenses_status on public.expenses (status);
create index if not exists idx_expenses_submitted_by on public.expenses (submitted_by_staff_id);

-- Receipts share the private job-media bucket; allow PDFs (emailed receipts) too.
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
where id = 'job-media';
