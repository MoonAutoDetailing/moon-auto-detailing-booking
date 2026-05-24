-- Align expenses.payment_method check constraint with admin API + UI allowed values.
-- Safe to re-run: drops any existing payment_method check on public.expenses first.

do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'expenses'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%payment_method%'
  loop
    execute format('alter table public.expenses drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.expenses
  add constraint expenses_payment_method_check
  check (payment_method in (
    'Cash',
    'PayPal',
    'Venmo',
    'Check',
    'Credit Card',
    'Bank Transfer',
    'Other'
  ));
