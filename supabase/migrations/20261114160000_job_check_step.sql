-- One checklist tick at a time, atomically, so two people working the same job never
-- overwrite each other's ticks. Starts the job if it hadn't been started.
create or replace function public.job_check_step(p_booking uuid, p_step text, p_on boolean, p_staff uuid)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  insert into public.job_completions as jc (booking_id, started_at, started_by, checklist, updated_at)
  values (p_booking, now(), p_staff, case when p_on then jsonb_build_object(p_step, true) else '{}'::jsonb end, now())
  on conflict (booking_id) do update
    set checklist = case when p_on then jc.checklist || jsonb_build_object(p_step, true) else jc.checklist - p_step end,
        started_at = coalesce(jc.started_at, now()),
        started_by = coalesce(jc.started_by, p_staff),
        updated_at = now()
  returning jc.checklist;
$$;
-- Server (service role) only: the anon key is public.
revoke all on function public.job_check_step(uuid, text, boolean, uuid) from public, anon, authenticated;
