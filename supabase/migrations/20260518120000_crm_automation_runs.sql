-- CRM automation runs: dedupe internal follow-up task generation.
-- Run in Supabase SQL editor or via migration tooling before enabling cron-crm-automation.

create table if not exists public.crm_automation_runs (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null,
  source_type text not null,
  source_id uuid not null,
  customer_id uuid references public.customers(id) on delete cascade,
  task_id uuid references public.crm_follow_up_tasks(id) on delete set null,
  created_at timestamptz default now(),
  constraint crm_automation_runs_rule_source_unique unique (rule_key, source_type, source_id)
);

create index if not exists crm_automation_runs_customer_id_idx
  on public.crm_automation_runs (customer_id);

create index if not exists crm_automation_runs_rule_key_idx
  on public.crm_automation_runs (rule_key);
