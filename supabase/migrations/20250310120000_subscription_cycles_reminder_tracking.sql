-- Reminder send tracking for subscription_cycles.
-- reminder_1 = 3 days before effective end; reminder_2 = 1 day before effective end.

alter table public.subscription_cycles
add column if not exists reminder_1_sent_at timestamptz,
add column if not exists reminder_2_sent_at timestamptz;
