-- Owner assignments always write in_progress/completed, even when their values
-- are unchanged. Only internal reconciliation writes in_progress -> missed.
-- Preserve the applied occurrence migration and its narrow RPC exception handler.
create or replace function public.guard_occurrence_update() returns trigger
language plpgsql set search_path = '' as $$
declare n timestamptz;
begin
  n=public.occurrence_now();
  if (new.id,new.habit_id,new.owner_id,new.local_date,new.timezone,new.closes_at,new.snapshot,new.created_at)
     is distinct from (old.id,old.habit_id,old.owner_id,old.local_date,old.timezone,old.closes_at,old.snapshot,old.created_at) then
    raise exception 'immutable_occurrence';
  end if;
  if n >= old.closes_at and (
      old.state='in_progress' and new.state='missed'
      and (new.progress,new.completed) is not distinct from (old.progress,old.completed)
    ) is not true then
    raise exception 'occurrence_closed';
  end if;
  if old.state='missed' and new.state<>old.state then raise exception 'occurrence_closed'; end if;
  if new.state is distinct from (case when new.completed then 'completed'
      when n >= old.closes_at then 'missed' else 'in_progress' end) then
    raise exception 'invalid_occurrence_state';
  end if;
  new.updated_at=n;
  return new;
end;
$$;

-- CREATE OR REPLACE retains the existing ACL; restate the helper-only boundary.
revoke execute on function public.guard_occurrence_update()
  from public,anon,authenticated,service_role;
