-- Private configuration only. Future occurrences must snapshot configuration.
-- All JSON keys are configuration; identity and lifecycle columns stay separate.
create function public.normalize_habit_configuration(c jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  days jsonb;
  reminders jsonb;
  item jsonb;
begin
  if c is null or jsonb_typeof(c) <> 'object'
     or not (c ?& array['name','description','type','target','unit','schedule','weekdays','reminder_times'])
     or (c - array['name','description','type','target','unit','schedule','weekdays','reminder_times']) <> '{}'::jsonb
     or jsonb_typeof(c->'name') <> 'string'
     or char_length(btrim(c->>'name')) not between 1 and 100
     or (c->'description' <> 'null'::jsonb and
         (jsonb_typeof(c->'description') <> 'string' or char_length(c->>'description') > 1000))
     or c->>'type' not in ('binary','target') or jsonb_typeof(c->'type') <> 'string'
     or c->>'schedule' not in ('daily','selected') or jsonb_typeof(c->'schedule') <> 'string'
     or jsonb_typeof(c->'weekdays') <> 'array'
     or jsonb_typeof(c->'reminder_times') <> 'array' then
    raise exception 'invalid_habit_configuration';
  end if;
  if c->>'type' = 'binary' then
    if c->'target' <> 'null'::jsonb or c->'unit' <> 'null'::jsonb then
      raise exception 'invalid_habit_configuration';
    end if;
  else
    if jsonb_typeof(c->'target') <> 'number' then
      raise exception 'invalid_habit_configuration';
    end if;
    if (c->>'target')::numeric <= 0 or trunc((c->>'target')::numeric) <> (c->>'target')::numeric then
      raise exception 'invalid_habit_configuration';
    end if;
  end if;
  if c->'unit' <> 'null'::jsonb and
     (jsonb_typeof(c->'unit') <> 'string' or char_length(btrim(c->>'unit')) not between 1 and 30) then
    raise exception 'invalid_habit_configuration';
  end if;
  for item in select value from jsonb_array_elements(c->'weekdays') loop
    if jsonb_typeof(item) <> 'number' then raise exception 'invalid_habit_configuration'; end if;
    if (item #>> '{}')::numeric not between 1 and 7 or trunc((item #>> '{}')::numeric) <> (item #>> '{}')::numeric then
      raise exception 'invalid_habit_configuration';
    end if;
  end loop;
  select coalesce(jsonb_agg((value #>> '{}')::numeric::int order by (value #>> '{}')::numeric), '[]'::jsonb) into days
    from (select distinct value from jsonb_array_elements(c->'weekdays')) d;
  if jsonb_array_length(days) <> jsonb_array_length(c->'weekdays')
     or (c->>'schedule' = 'daily' and days <> '[]'::jsonb)
     or (c->>'schedule' = 'selected' and jsonb_array_length(days) not between 1 and 7) then
    raise exception 'invalid_habit_configuration';
  end if;
  for item in select value from jsonb_array_elements(c->'reminder_times') loop
    if jsonb_typeof(item) <> 'string' or (item #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'invalid_habit_configuration';
    end if;
  end loop;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb) into reminders
    from (select distinct value from jsonb_array_elements(c->'reminder_times')) r;
  if jsonb_array_length(reminders) = 0 or jsonb_array_length(reminders) <> jsonb_array_length(c->'reminder_times') then
    raise exception 'invalid_habit_configuration';
  end if;
  return c || jsonb_build_object('name', btrim(c->>'name'), 'unit', case when c->'unit' = 'null'::jsonb then null else btrim(c->>'unit') end,
    'weekdays', days, 'reminder_times', reminders);
end;
$$;

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  configuration jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  constraint habits_configuration_valid check (configuration = public.normalize_habit_configuration(configuration))
);
create index habits_owner_created_id_idx on public.habits(owner_id, created_at, id);
create index habits_owner_archive_idx on public.habits(owner_id, archived_at);
alter table public.habits enable row level security;
-- No friend or client policies. Also defeat Supabase default grants explicitly.
revoke all on public.habits from public, anon, authenticated, service_role;

create function public.guard_habit_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.owner_id <> old.owner_id or new.created_at <> old.created_at
     or new.configuration->'type' <> old.configuration->'type' then
    raise exception 'invalid_habit_configuration';
  end if;
  if old.archived_at is not null and new.configuration <> old.configuration then
    raise exception 'habit_archived';
  end if;
  new.updated_at = clock_timestamp();
  return new;
end;
$$;
create trigger habits_guard_update before update on public.habits
for each row execute function public.guard_habit_update();

create function public.habit_view(h public.habits)
returns jsonb language sql immutable set search_path = '' as $$
  select (to_jsonb(h) - 'configuration') || h.configuration;
$$;

create function public.require_habit_profile(p_owner uuid)
returns void language plpgsql set search_path = '' as $$
begin
  -- Serialize with profile deletion; held until the entry point commits.
  perform 1 from public.profiles where user_id = p_owner for key share;
  if not found then raise exception 'profile_not_found'; end if;
end;
$$;

create function public.create_habit(p_owner uuid, p_config jsonb)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare h public.habits;
begin
  perform public.require_habit_profile(p_owner);
  insert into public.habits(owner_id,configuration)
    values(p_owner,public.normalize_habit_configuration(p_config)) returning * into h;
  return next public.habit_view(h);
end;
$$;

create function public.list_habits(p_owner uuid, p_status text default 'active')
returns setof jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_habit_profile(p_owner);
  if p_status is null or p_status not in ('active','archived','all') then raise exception 'invalid_habit_configuration'; end if;
  return query select public.habit_view(h) from public.habits h where h.owner_id = p_owner
    and (p_status = 'all' or (p_status = 'active' and h.archived_at is null) or (p_status = 'archived' and h.archived_at is not null))
    order by h.created_at, h.id;
end;
$$;

create function public.get_habit(p_owner uuid, p_habit uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_habit_profile(p_owner);
  return query select public.habit_view(h) from public.habits h where h.owner_id = p_owner and h.id = p_habit;
end;
$$;

create function public.update_habit(p_owner uuid, p_habit uuid, p_changes jsonb)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare h public.habits; merged jsonb;
begin
  perform public.require_habit_profile(p_owner);
  select * into h from public.habits where owner_id = p_owner and id = p_habit for update;
  if not found then return; end if;
  if h.archived_at is not null then raise exception 'habit_archived'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
     or (p_changes - array['name','description','target','unit','schedule','weekdays','reminder_times']) <> '{}'::jsonb then
    raise exception 'invalid_habit_configuration';
  end if;
  merged = public.normalize_habit_configuration(h.configuration || p_changes);
  update public.habits set configuration = merged where owner_id = p_owner and id = p_habit returning * into h;
  return next public.habit_view(h);
end;
$$;

create function public.archive_habit(p_owner uuid, p_habit uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare h public.habits;
begin
  perform public.require_habit_profile(p_owner);
  select * into h from public.habits where owner_id = p_owner and id = p_habit for update;
  if not found then return; end if;
  if h.archived_at is null then
    update public.habits set archived_at = clock_timestamp() where owner_id = p_owner and id = p_habit returning * into h;
  end if;
  return next public.habit_view(h);
end;
$$;

create function public.restore_habit(p_owner uuid, p_habit uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare h public.habits;
begin
  perform public.require_habit_profile(p_owner);
  select * into h from public.habits where owner_id = p_owner and id = p_habit for update;
  if not found then return; end if;
  if h.archived_at is not null then
    update public.habits set archived_at = null where owner_id = p_owner and id = p_habit returning * into h;
  end if;
  return next public.habit_view(h);
end;
$$;

-- Helpers are callable only by their owner, including via definer entry points.
revoke execute on function public.normalize_habit_configuration(jsonb), public.guard_habit_update(),
  public.habit_view(public.habits), public.require_habit_profile(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.create_habit(uuid,jsonb), public.list_habits(uuid,text), public.get_habit(uuid,uuid),
  public.update_habit(uuid,uuid,jsonb), public.archive_habit(uuid,uuid), public.restore_habit(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_habit(uuid,jsonb), public.list_habits(uuid,text), public.get_habit(uuid,uuid),
  public.update_habit(uuid,uuid,jsonb), public.archive_habit(uuid,uuid), public.restore_habit(uuid,uuid)
  to service_role;
