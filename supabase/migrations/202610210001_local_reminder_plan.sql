-- Scheduling projection only. Cursor/reconciliation helpers remain private.
create function public.get_local_reminder_plan(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today jsonb; z text; d date; n timestamptz; effective jsonb; future jsonb;
begin
  -- get_today takes the owner lock and reconciles through a stable current date.
  today=public.get_today(p_owner);
  z=today->>'timezone'; d=(today->>'local_date')::date;
  n=(today->>'server_time')::timestamptz;
  select coalesce(jsonb_agg(jsonb_build_object(
    'habit_id',o.habit_id,'local_date',o.local_date,'timezone',o.timezone,
    'closes_at',o.closes_at,'reminder_times',o.snapshot->'reminder_times'
  ) order by o.habit_id,o.local_date),'[]'::jsonb) into effective
  from public.habit_occurrences o where o.owner_id=p_owner and o.closes_at>n;
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
