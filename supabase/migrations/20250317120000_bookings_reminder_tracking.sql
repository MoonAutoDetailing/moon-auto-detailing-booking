-- Reminder send tracking for standard (non-subscription) confirmed bookings.
-- reminder_48_sent_at = 48 hours before scheduled_start; reminder_8_sent_at = 8 hours before.

alter table public.bookings
add column if not exists reminder_48_sent_at timestamptz,
add column if not exists reminder_8_sent_at timestamptz;
