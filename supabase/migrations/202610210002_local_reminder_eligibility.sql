-- Refresh the delivery projection from current server eligibility. Occurrence
-- snapshots and tracking watermarks remain authoritative for dates/configuration.
create or replace function public.get_local_reminder_plan(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today jsonb; z text; d date; n timestamptz; effective jsonb; future jsonb;
begin
  -- get_today holds the owner lock used by habit/occurrence/excuse mutations.
  today=public.get_today(p_owner);
  z=today->>'timezone'; d=(today->>'local_date')::date;
  n=(today->>'server_time')::timestamptz;
  select coalesce(jsonb_agg(jsonb_build_object(
    'habit_id',o.habit_id,'local_date',o.local_date,'timezone',o.timezone,
    'closes_at',o.closes_at,'reminder_times',o.snapshot->'reminder_times'
  ) order by o.habit_id,o.local_date),'[]'::jsonb) into effective
  from public.habit_occurrences o
  join public.habits h on h.id=o.habit_id and h.owner_id=o.owner_id
  where o.owner_id=p_owner and h.archived_at is null
    and o.closes_at>n and o.state='in_progress' and not o.completed
    and not exists (select 1 from public.occurrence_excuses e where e.occurrence_id=o.id);
  -- Completion and excuses suppress only that occurrence. Later scheduled dates
  -- still use the current habit configuration and the existing no-rewind floor.
  select coalesce(jsonb_agg(jsonb_build_object(
    'habit_id',h.id,'schedule',h.configuration->'schedule',
    'weekdays',h.configuration->'weekdays','reminder_times',h.configuration->'reminder_times',
    'eligible_from',greatest(t.next_date,t.eligible_from,d+1)
  ) order by h.id),'[]'::jsonb) into future
  from public.habits h join public.habit_tracking t on t.habit_id=h.id
  where h.owner_id=p_owner and h.archived_at is null;
  return jsonb_build_object('version',1,'owner_id',p_owner,'server_time',n,
    'local_date',d,'timezone',z,'effective',effective,'future',future);
end;
$$;
revoke all on function public.get_local_reminder_plan(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_local_reminder_plan(uuid) to service_role;
