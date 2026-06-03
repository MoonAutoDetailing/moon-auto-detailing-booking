create table if not exists public.crm_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  note text not null,
  pinned boolean default false,
  created_by text default 'admin',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_crm_notes_customer_id
  on public.crm_notes (customer_id);

create index if not exists idx_crm_notes_created_at
  on public.crm_notes (created_at);

create index if not exists idx_crm_notes_pinned
  on public.crm_notes (pinned);
