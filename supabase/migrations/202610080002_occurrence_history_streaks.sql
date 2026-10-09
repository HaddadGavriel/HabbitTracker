-- History and current streaks use stored occurrences, including their immutable
-- dates/configuration snapshots. No calendar gaps or pre-cutover dates are
-- synthesized by these queries, and late excuse decisions remain authoritative.
create index occurrences_habit_history_idx
  on public.habit_occurrences(habit_id, local_date desc, id desc) include (state);
create index occurrences_habit_missed_idx
  on public.habit_occurrences(habit_id, local_date desc, id desc)
  where state = 'missed';

-- Internal projection only: callers must authorize, acquire profile locks, and
-- reconcile first. In particular, this function never establishes access from
-- an occurrence or habit identifier supplied by a client.
create function public.habit_streak_summary(p_habit uuid, p_calculated_at timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  with last_missed as (
    select local_date, id from public.habit_occurrences
      where habit_id = p_habit and state = 'missed'
      order by local_date desc, id desc limit 1
  )
  select jsonb_build_object(
    'habit_id', p_habit,
    'current_streak', count(*) filter (where o.state in ('completed', 'excused')),
    'provisional', coalesce(bool_or(o.state = 'justification_pending'), false),
    'calculated_at', p_calculated_at)
  from public.habit_occurrences o left join last_missed m on true
  where o.habit_id = p_habit
    and (m.id is null or (o.local_date, o.id) > (m.local_date, m.id));
$$;

create function public.get_habit_streak(p_owner uuid, p_habit uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare owner_today jsonb;
begin
  -- Do not call require_habit_profile here: it reconciles before authorization.
  -- Holding the owner lock orders this whole read with progress/configuration,
  -- archival, and excuse decisions. Shared mutations lock the same profiles in
  -- UUID order before touching occurrences or grants.
  perform public.lock_share_profiles(array[p_owner]);
  if not exists(select 1 from public.profiles where user_id = p_owner) then
    raise exception 'profile_not_found';
  end if;
  perform 1 from public.habits where id = p_habit and owner_id = p_owner;
  if not found then return; end if;
  -- Reuse Today's midnight loop and final deadline reconciliation. Its timestamp
  -- is the authoritative as-of time, including on unscheduled or archived days.
  owner_today = public.get_today(p_owner);
  return next public.habit_streak_summary(p_habit, (owner_today->>'server_time')::timestamptz);
end;
$$;

create function public.get_habit_history(
  p_owner uuid,
  p_habit uuid,
  p_limit integer default 30,
  p_from_date date default null,
  p_to_date date default null,
  p_cursor jsonb default null
)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare cursor_date date; cursor_id uuid; rows jsonb; boundary jsonb; next_cursor jsonb;
begin
  -- Authorization never depends on a cursor, a share, or active/archive state.
  -- Unauthorized calls also never reconcile either the caller or another owner.
  perform public.lock_share_profiles(array[p_owner]);
  if not exists(select 1 from public.profiles where user_id = p_owner) then
    raise exception 'profile_not_found';
  end if;
  perform 1 from public.habits where id = p_habit and owner_id = p_owner;
  if not found then return; end if;

  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'invalid_history_limit';
  end if;
  if (p_from_date is not null and p_from_date not between date '0001-01-01' and date '9999-12-31')
      or (p_to_date is not null and p_to_date not between date '0001-01-01' and date '9999-12-31')
      or p_from_date > p_to_date then
    raise exception using errcode = 'P0001', message = 'invalid_history_range';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) is distinct from 'object' then
      raise exception using errcode = 'P0001', message = 'invalid_history_cursor';
    end if;
    if not p_cursor ?& array['v', 'habit_id', 'from_date', 'to_date', 'local_date', 'id']
        or (select count(*) from jsonb_object_keys(p_cursor)) <> 6
        or jsonb_typeof(p_cursor->'v') is distinct from 'number'
        or p_cursor->>'v' is distinct from '1'
        or p_cursor->'habit_id' is distinct from to_jsonb(p_habit)
        or p_cursor->'from_date' is distinct from coalesce(to_jsonb(p_from_date), 'null'::jsonb)
        or p_cursor->'to_date' is distinct from coalesce(to_jsonb(p_to_date), 'null'::jsonb)
        or jsonb_typeof(p_cursor->'local_date') is distinct from 'string'
        or jsonb_typeof(p_cursor->'id') is distinct from 'string'
        or (p_cursor->>'local_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (p_cursor->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'invalid_history_cursor';
    end if;
    begin
      cursor_date = (p_cursor->>'local_date')::date;
      cursor_id = (p_cursor->>'id')::uuid;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = 'P0001', message = 'invalid_history_cursor';
    end;
    if cursor_date < p_from_date or cursor_date > p_to_date
        or not exists(select 1 from public.habit_occurrences
          where habit_id = p_habit and local_date = cursor_date and id = cursor_id) then
      raise exception using errcode = 'P0001', message = 'invalid_history_cursor';
    end if;
  end if;

  -- One RPC transaction holds the owner lock through reconciliation and the
  -- page projection, so state and nested decision metadata cannot disagree.
  perform public.get_today(p_owner);
  select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
      'excuse', case when e.id is null then null else jsonb_build_object(
        'id', e.id, 'explanation', e.explanation, 'status', e.status,
        'decision_source', e.decision_source, 'decided_by', e.decided_by,
        'decided_at', e.decided_at, 'created_at', e.created_at) end)
      order by o.local_date desc, o.id desc), '[]'::jsonb)
    into rows
    from (
      select * from public.habit_occurrences
        where habit_id = p_habit
          and (p_from_date is null or local_date >= p_from_date)
          and (p_to_date is null or local_date <= p_to_date)
          and (cursor_date is null or (local_date, id) < (cursor_date, cursor_id))
        order by local_date desc, id desc limit p_limit + 1
    ) o left join public.occurrence_excuses e on e.occurrence_id = o.id;
  if jsonb_array_length(rows) > p_limit then
    boundary = rows->(p_limit - 1);
    rows = rows - p_limit;
    next_cursor = jsonb_build_object('v', 1, 'habit_id', p_habit,
      'from_date', p_from_date, 'to_date', p_to_date,
      'local_date', boundary->'local_date', 'id', boundary->'id');
  end if;
  return next jsonb_build_object('habit_id', p_habit, 'occurrences', rows, 'next_cursor', next_cursor);
end;
$$;

-- Existing shared entry points already discover all candidate owners, acquire
-- sorted profile locks, recheck current sharing/archival, then call get_today.
-- Reuse that transaction and its timestamp. The allowlist continues to exclude
-- excuse explanations/decision metadata and all historical occurrence rows.
create or replace function public.shared_habit_view(h public.habits, p_today jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', h.id,
    'owner', jsonb_build_object('user_id', p.user_id, 'username', p.username, 'display_name', p.display_name),
    'configuration', h.configuration,
    'local_date', p_today->'local_date', 'timezone', p_today->'timezone', 'server_time', p_today->'server_time',
    'due_today', o.item is not null,
    'occurrence', case when o.item is null then null else jsonb_build_object(
      'id', o.item->'id', 'local_date', o.item->'local_date', 'timezone', o.item->'timezone',
      'closes_at', o.item->'closes_at', 'snapshot', o.item->'snapshot', 'progress', o.item->'progress',
      'completed', o.item->'completed', 'state', o.item->'state') end)
    || (public.habit_streak_summary(h.id, (p_today->>'server_time')::timestamptz) - 'habit_id')
  from public.profiles p
  left join lateral (
    select value as item from jsonb_array_elements(p_today->'occurrences')
    where value->>'habit_id' = h.id::text
  ) o on true
  where p.user_id = h.owner_id;
$$;

-- Tables remain protected by their existing RLS and explicit privilege
-- revocations. Helpers have no direct client/service access; only backend RPCs
-- can invoke them, using their fixed, empty search_path.
revoke execute on function public.habit_streak_summary(uuid,timestamptz),
  public.shared_habit_view(public.habits,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_habit_history(uuid,uuid,integer,date,date,jsonb),
  public.get_habit_streak(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_habit_history(uuid,uuid,integer,date,date,jsonb),
  public.get_habit_streak(uuid,uuid)
  to service_role;
