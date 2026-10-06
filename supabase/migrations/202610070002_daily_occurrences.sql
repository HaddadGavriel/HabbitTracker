-- Reconciliation cursors are checkpointed in the SAME transaction as every
-- configuration/lifecycle change. Thus no unmaterialized date can lose its config.
create function public.occurrence_now() returns timestamptz
language sql volatile set search_path = '' as $$ select clock_timestamp(); $$;

create table public.habit_tracking (
  habit_id uuid primary key references public.habits(id) on delete cascade,
  next_date date not null,
  timezone text not null,
  eligible_from date not null
);
alter table public.habits add constraint habits_id_owner_unique unique(id,owner_id);
create table public.habit_occurrences (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.habits(id) on delete cascade,
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  local_date date not null,
  timezone text not null,
  closes_at timestamptz not null,
  snapshot jsonb not null,
  progress numeric not null default 0 check (progress >= 0 and progress = trunc(progress)),
  completed boolean not null default false,
  state text not null default 'in_progress' check (state in ('in_progress','completed','missed')),
  created_at timestamptz not null default public.occurrence_now(),
  updated_at timestamptz not null default public.occurrence_now(),
  unique(habit_id,local_date),
  foreign key(habit_id,owner_id) references public.habits(id,owner_id) on delete cascade,
  check (snapshot = public.normalize_habit_configuration(snapshot)),
  check ((snapshot->>'type' = 'binary' and progress = 0) or
    (snapshot->>'type' = 'target' and completed = (progress >= (snapshot->>'target')::numeric))),
  check ((state = 'completed') = completed)
);
create index occurrences_owner_date on public.habit_occurrences(owner_id,local_date,habit_id);
create table public.occurrence_adjustments (
  occurrence_id uuid not null references public.habit_occurrences(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  delta numeric not null check (delta = trunc(delta)),
  result jsonb not null,
  created_at timestamptz not null default public.occurrence_now(),
  primary key(occurrence_id,key)
);
alter table public.habit_tracking enable row level security;
alter table public.habit_occurrences enable row level security;
alter table public.occurrence_adjustments enable row level security;
revoke all on public.habit_tracking, public.habit_occurrences, public.occurrence_adjustments
  from public, anon, authenticated, service_role;

-- Existing habits start at migration-time local date, never their creation date.
insert into public.habit_tracking
select h.id, (statement_timestamp() at time zone p.timezone)::date, p.timezone,
  (statement_timestamp() at time zone p.timezone)::date
from public.habits h join public.profiles p on p.user_id=h.owner_id;

create function public.guard_occurrence_update() returns trigger
language plpgsql set search_path = '' as $$
declare n timestamptz;
begin
  n=public.occurrence_now();
  if (new.id,new.habit_id,new.owner_id,new.local_date,new.timezone,new.closes_at,new.snapshot,new.created_at)
     is distinct from (old.id,old.habit_id,old.owner_id,old.local_date,old.timezone,old.closes_at,old.snapshot,old.created_at) then
    raise exception 'immutable_occurrence';
  end if;
  if n >= old.closes_at and (new.progress,new.completed) is distinct from (old.progress,old.completed) then
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
create trigger occurrences_guard_update before update on public.habit_occurrences
for each row execute function public.guard_occurrence_update();

create function public.materialize_occurrence(h public.habits, d date, z text)
returns void language plpgsql set search_path = '' as $$
begin
  if h.archived_at is null and (h.configuration->>'schedule' = 'daily' or
      h.configuration->'weekdays' @> to_jsonb(extract(isodow from d)::int)) then
    insert into public.habit_occurrences(habit_id,owner_id,local_date,timezone,closes_at,snapshot)
    values(h.id,h.owner_id,d,z,(d+1)::timestamp at time zone z,h.configuration)
    on conflict(habit_id,local_date) do nothing;
  end if;
end;
$$;

create function public.reconcile_occurrences(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
declare h public.habits; t public.habit_tracking; d date; today date; n timestamptz;
begin
  -- All entry points acquire this owner lock before habit/occurrence locks.
  perform 1 from public.profiles where user_id=p_owner for update;
  if not found then raise exception 'profile_not_found'; end if;
  n = public.occurrence_now();
  for h in select * from public.habits where owner_id=p_owner order by id loop
    select * into strict t from public.habit_tracking where habit_id=h.id;
    today = (n at time zone t.timezone)::date;
    if t.next_date <= today then
      if h.archived_at is null then
        for d in select t.next_date + i from generate_series(0,today-t.next_date) i loop
          perform public.materialize_occurrence(h,d,t.timezone);
        end loop;
      end if;
      update public.habit_tracking set next_date=today+1 where habit_id=h.id;
    end if;
  end loop;
  update public.habit_occurrences set state='missed',updated_at=n
    where owner_id=p_owner and closes_at<=n and state='in_progress';
end;
$$;

create or replace function public.require_habit_profile(p_owner uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.reconcile_occurrences(p_owner);
end;
$$;

create function public.track_new_habit() returns trigger
language plpgsql set search_path = '' as $$
declare z text; d date;
begin
  select timezone into strict z from public.profiles where user_id=new.owner_id for update;
  d=(public.occurrence_now() at time zone z)::date;
  insert into public.habit_tracking values(new.id,d+1,z,d);
  perform public.materialize_occurrence(new,d,z);
  return new;
end;
$$;
create trigger habits_track_insert after insert on public.habits
for each row execute function public.track_new_habit();

create function public.reconcile_habit_edit() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform public.reconcile_occurrences(old.owner_id);
  return new;
end;
$$;
create trigger habits_reconcile_edit before update on public.habits
for each row execute function public.reconcile_habit_edit();

create function public.track_habit_restore() returns trigger
language plpgsql set search_path = '' as $$
declare t public.habit_tracking; d date;
begin
  if old.archived_at is not null and new.archived_at is null then
    select * into strict t from public.habit_tracking where habit_id=new.id;
    d=(public.occurrence_now() at time zone t.timezone)::date;
    if d >= t.eligible_from then perform public.materialize_occurrence(new,d,t.timezone); end if;
  end if;
  return new;
end;
$$;
create trigger habits_track_restore after update on public.habits
for each row execute function public.track_habit_restore();

create function public.reconcile_timezone_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.timezone is distinct from old.timezone then
    -- Reject invalid zones even when written through the backend DB role.
    if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
      raise exception 'invalid_timezone';
    end if;
    perform public.reconcile_occurrences(old.user_id);
  end if;
  return new;
end;
$$;
create function public.track_timezone_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d date;
begin
  if new.timezone is distinct from old.timezone then
    d=(public.occurrence_now() at time zone new.timezone)::date;
    update public.habit_tracking set timezone=new.timezone,
      next_date=greatest(next_date,d),eligible_from=greatest(next_date,d)
      where habit_id in (select id from public.habits where owner_id=new.user_id);
    perform public.reconcile_occurrences(new.user_id);
  end if;
  return new;
end;
$$;
create trigger profiles_reconcile_timezone before update on public.profiles
for each row execute function public.reconcile_timezone_edit();
create trigger profiles_track_timezone after update on public.profiles
for each row execute function public.track_timezone_edit();

create function public.get_today(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare z text; d date; n timestamptz; before_date date; rows jsonb;
begin
  perform 1 from public.profiles where user_id=p_owner for update;
  if not found then raise exception 'profile_not_found'; end if;
  select timezone into z from public.profiles where user_id=p_owner;
  -- If a slow reconciliation crosses midnight, reconcile the newly due day too.
  loop
    before_date=(public.occurrence_now() at time zone z)::date;
    perform public.reconcile_occurrences(p_owner);
    n=public.occurrence_now(); d=(n at time zone z)::date;
    exit when before_date=d;
  end loop;
  update public.habit_occurrences set state='missed',updated_at=n
    where owner_id=p_owner and closes_at<=n and state='in_progress';
  select coalesce(jsonb_agg(to_jsonb(o) order by o.habit_id,o.id),'[]'::jsonb) into rows
    from public.habit_occurrences o where owner_id=p_owner and local_date=d;
  return jsonb_build_object('local_date',d,'timezone',z,'server_time',n,'occurrences',rows);
end;
$$;

create function public.mutate_occurrence(p_owner uuid,p_occurrence uuid,p_operation text,p_value jsonb,p_key text default null)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare o public.habit_occurrences; a public.occurrence_adjustments; v numeric; result jsonb; n timestamptz;
begin
  perform public.require_habit_profile(p_owner);
  select * into o from public.habit_occurrences where owner_id=p_owner and id=p_occurrence for update;
  if not found then return; end if;
  -- Error envelopes allow reconciliation to COMMIT even for refused edits.
  if p_operation not in ('completion','progress','adjustment') or p_operation is null then
    return next jsonb_build_object('error','invalid_occurrence_value'); return;
  end if;
  if (p_operation='completion') <> (o.snapshot->>'type'='binary') then
    return next jsonb_build_object('error','wrong_occurrence_type'); return;
  end if;
  if p_operation='completion' then
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      return next jsonb_build_object('error','invalid_occurrence_value'); return;
    end if;
  else
    if jsonb_typeof(p_value) is distinct from 'number' or (p_value #>> '{}') !~ '^-?[0-9]+$' then
      return next jsonb_build_object('error','invalid_occurrence_value'); return;
    end if;
    v=(p_value #>> '{}')::numeric;
    if p_operation='adjustment' then
      if p_key is null or p_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
        return next jsonb_build_object('error','invalid_idempotency_key'); return;
      end if;
      select * into a from public.occurrence_adjustments where occurrence_id=o.id and key=p_key;
      if found then
        if a.delta <> v then return next jsonb_build_object('error','idempotency_conflict');
        else return next a.result; end if;
        return;
      end if;
      v=o.progress+v;
    end if;
  end if;
  n=public.occurrence_now();
  if n >= o.closes_at then
    update public.habit_occurrences set state='missed',updated_at=n where id=o.id and state='in_progress';
    return next jsonb_build_object('error','occurrence_closed'); return;
  end if;
  if v < 0 then return next jsonb_build_object('error','negative_progress'); return; end if;
  if p_operation='completion' then o.completed=(p_value #>> '{}')::boolean;
  else o.progress=v; o.completed=v >= (o.snapshot->>'target')::numeric; end if;
  begin
    update public.habit_occurrences set progress=o.progress,completed=o.completed,
      state=case when o.completed then 'completed' else 'in_progress' end,updated_at=n
      where id=o.id returning to_jsonb(habit_occurrences) into result;
  exception when raise_exception then
    -- Midnight can fall between the check and the UPDATE trigger. Its rejected
    -- update rolls back only this subtransaction; reconciliation still commits.
    if sqlerrm <> 'occurrence_closed' then raise; end if;
    update public.habit_occurrences set state='missed'
      where id=o.id and state='in_progress';
    return next jsonb_build_object('error','occurrence_closed'); return;
  end;
  if p_operation='adjustment' then
    insert into public.occurrence_adjustments(occurrence_id,key,delta,result)
      values(o.id,p_key,(p_value #>> '{}')::numeric,result);
  end if;
  return next result;
end;
$$;

-- No production clock override, test parameter, or client table/function access.
revoke execute on function public.occurrence_now(),public.materialize_occurrence(public.habits,date,text),
  public.guard_occurrence_update(),
  public.reconcile_occurrences(uuid),public.track_new_habit(),public.reconcile_habit_edit(),
  public.track_habit_restore(),public.reconcile_timezone_edit(),public.track_timezone_edit()
  from public,anon,authenticated,service_role;
revoke execute on function public.get_today(uuid),public.mutate_occurrence(uuid,uuid,text,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_today(uuid),public.mutate_occurrence(uuid,uuid,text,jsonb,text) to service_role;
