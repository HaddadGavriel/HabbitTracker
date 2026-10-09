-- One Expo installation token has one current account owner. Keep the most
-- recent legacy registration before enforcing global token uniqueness.
delete from public.device_push_tokens old using (
  select id, row_number() over (
    partition by expo_push_token order by updated_at desc, created_at desc, id desc
  ) as position from public.device_push_tokens
) ranked where old.id = ranked.id and ranked.position > 1;
alter table public.device_push_tokens
  add constraint device_push_tokens_token_key unique(expo_push_token);

-- Preserve the infrastructure probe's backend-only latest-token SELECT, but
-- route every registration write through the ownership-transfer RPC.
revoke all on public.device_push_tokens from public, anon, authenticated, service_role;
grant select on public.device_push_tokens to service_role;

create function public.register_device(p_user uuid, p_token text, p_platform text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare registered_at timestamptz;
begin
  if p_token is null or char_length(p_token) > 256
      or p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
      or p_platform is null or p_platform not in ('android', 'ios') then
    raise exception using errcode = 'P0001', message = 'invalid_device_registration';
  end if;
  -- No profile is required: device registration may precede onboarding. The
  -- auth.users FK still requires a real authenticated account. Unique-token
  -- UPSERT serializes competing account switches across backend workers.
  insert into public.device_push_tokens as devices(user_id, expo_push_token, platform, updated_at)
    values(p_user, p_token, p_platform, public.occurrence_now())
    on conflict (expo_push_token) do update
      set user_id = excluded.user_id, platform = excluded.platform,
        updated_at = greatest(public.occurrence_now(), devices.updated_at + interval '1 microsecond')
    returning updated_at into registered_at;
  -- A strictly newer version protects a refreshed registration from cleanup
  -- by an older send, even if two registrations observe the same clock tick.
  return registered_at;
end;
$$;

-- Private reservation/outcome audit. Tokens and generated message snapshots
-- must never appear in public summaries or direct client table access.
create table public.habit_reminders (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(user_id) on delete cascade,
  owner_id uuid not null references public.profiles(user_id) on delete cascade,
  habit_id uuid not null,
  occurrence_id uuid not null references public.habit_occurrences(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  status text not null check (status in (
    'reserved', 'provider_accepted', 'partially_accepted', 'failed', 'unknown', 'no_devices'
  )),
  reserved_at timestamptz not null,
  finished_at timestamptz,
  devices jsonb not null check (jsonb_typeof(devices) = 'array'),
  notification jsonb not null check (jsonb_typeof(notification) = 'object'),
  results jsonb check (jsonb_typeof(results) = 'array'),
  device_count integer not null check (device_count >= 0 and device_count = jsonb_array_length(devices)),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  unknown_count integer not null default 0 check (unknown_count >= 0),
  unique(sender_id, habit_id, key),
  foreign key(habit_id, owner_id) references public.habits(id, owner_id) on delete cascade,
  check (sender_id <> owner_id),
  check (finished_at is null or finished_at >= reserved_at),
  check ((status = 'reserved' and finished_at is null and results is null
      and device_count > 0 and accepted_count + failed_count + unknown_count = 0)
    or (status <> 'reserved' and finished_at is not null and results is not null
      and accepted_count + failed_count + unknown_count = device_count))
);
create index habit_reminders_cooldown_idx
  on public.habit_reminders(sender_id, habit_id, reserved_at desc, id desc);
create index habit_reminders_owner_idx on public.habit_reminders(owner_id);
create index habit_reminders_occurrence_idx on public.habit_reminders(occurrence_id);
alter table public.habit_reminders enable row level security;
revoke all on public.habit_reminders from public, anon, authenticated, service_role;

create function public.habit_reminder_summary(r public.habit_reminders)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'habit_id', r.habit_id, 'occurrence_id', r.occurrence_id,
    'status', r.status, 'reserved_at', r.reserved_at, 'finished_at', r.finished_at,
    'retry_at', r.reserved_at + interval '60 minutes',
    'device_count', r.device_count, 'accepted_count', r.accepted_count,
    'failed_count', r.failed_count, 'unknown_count', r.unknown_count
  );
$$;

create function public.reserve_habit_reminder(p_sender uuid, p_habit uuid, p_key text)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; h public.habits; o public.habit_occurrences; r public.habit_reminders;
  owner_today jsonb; n timestamptz; previous_reservation timestamptz;
  device_snapshot jsonb; message jsonb; sender_name text; reminder_id uuid;
begin
  -- Discovery never authorizes. Lock the COMPLETE profile pair in UUID order
  -- before checking live access, exactly as sharing and excuse decisions do.
  select owner_id into v_owner from public.habits where id = p_habit;
  perform public.lock_share_profiles(array[p_sender, v_owner]);
  if not exists(select 1 from public.profiles where user_id = p_sender) then
    raise exception 'profile_not_found';
  end if;
  select * into h from public.habits where id = p_habit and owner_id = v_owner
    and archived_at is null and public.is_current_habit_recipient(v_owner, p_habit, p_sender);
  if not found then return; end if;

  if p_key is null or p_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    return next jsonb_build_object('error', 'invalid_idempotency_key'); return;
  end if;
  select * into r from public.habit_reminders
    where sender_id = p_sender and habit_id = p_habit and key = p_key;
  if found then
    -- A replay can inspect the committed outcome only while access is current.
    -- Even an unfinished/crashed reservation NEVER grants another dispatch.
    return next jsonb_build_object('dispatch', false, 'result', public.habit_reminder_summary(r));
    return;
  end if;

  loop
    owner_today = public.get_today(v_owner);
    select * into o from public.habit_occurrences
      where habit_id = p_habit and local_date = (owner_today->>'local_date')::date;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'expo_push_token', d.expo_push_token, 'updated_at', d.updated_at
      ) order by d.id), '[]'::jsonb) into device_snapshot
      from (
        -- Account transfer/invalid-token cleanup cannot commit between this
        -- snapshot and reservation commit. Device locks follow profile locks
        -- and use the same ID order as finalization; none span the Expo call.
        select * from public.device_push_tokens where user_id = v_owner
          order by id for share
      ) d;
    -- Refresh time after reconciliation and snapshot collection. If midnight
    -- passed, reuse Today's existing reconciliation/timezone transition rules.
    n = public.occurrence_now();
    exit when (n at time zone (owner_today->>'timezone'))::date = (owner_today->>'local_date')::date;
  end loop;
  if o.id is null or o.state <> 'in_progress' or o.completed or o.closes_at <= n then
    -- A stored occurrence may close before today's midnight after a timezone
    -- change. Persist that reconciliation even though the reminder is refused.
    update public.habit_occurrences set state = 'missed'
      where id = o.id and state = 'in_progress' and closes_at <= n;
    return next jsonb_build_object('error', 'reminder_not_eligible'); return;
  end if;

  select reserved_at into previous_reservation from public.habit_reminders
    where sender_id = p_sender and habit_id = p_habit order by reserved_at desc, id desc limit 1;
  if n < previous_reservation + interval '60 minutes' then
    return next jsonb_build_object('error', 'reminder_cooldown',
      'retry_at', previous_reservation + interval '60 minutes'); return;
  end if;
  select display_name into strict sender_name from public.profiles where user_id = p_sender;
  reminder_id = gen_random_uuid();
  message = jsonb_build_object('title', 'Habit reminder',
    'body', left(regexp_replace(sender_name, '[[:cntrl:]]', ' ', 'g'), 40)
      || ' reminded you: ' || left(regexp_replace(o.snapshot->>'name', '[[:cntrl:]]', ' ', 'g'), 80) || '.',
    'data', jsonb_build_object('type', 'habit_reminder', 'reminder_id', reminder_id,
      'habit_id', p_habit, 'occurrence_id', o.id));
  insert into public.habit_reminders(
    id, sender_id, owner_id, habit_id, occurrence_id, key, status, reserved_at,
    finished_at, devices, notification, results, device_count
  ) values (
    reminder_id, p_sender, v_owner, p_habit, o.id, p_key,
    case when jsonb_array_length(device_snapshot) = 0 then 'no_devices' else 'reserved' end, n,
    case when jsonb_array_length(device_snapshot) = 0 then n else null end,
    device_snapshot, message,
    case when jsonb_array_length(device_snapshot) = 0 then '[]'::jsonb else null end,
    jsonb_array_length(device_snapshot)
  ) returning * into r;

  -- Commit this RPC before contacting Expo. The reservation is the concurrency
  -- boundary: later revocation/archive/progress/account-switch cannot cancel an
  -- already authorized external send. No locks span the network request.
  if r.status = 'no_devices' then
    return next jsonb_build_object('dispatch', false, 'result', public.habit_reminder_summary(r));
  else
    return next jsonb_build_object('dispatch', true, 'devices', device_snapshot,
      'notification', message, 'result', public.habit_reminder_summary(r));
  end if;
end;
$$;

create function public.finish_habit_reminder(p_sender uuid, p_reminder uuid, p_results jsonb)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.habit_reminders; item jsonb; device_id uuid; seen uuid[] = '{}'::uuid[];
  accepted integer = 0; failed integer = 0; unknown integer = 0;
begin
  select * into r from public.habit_reminders where id = p_reminder and sender_id = p_sender for update;
  if not found then return; end if;
  if r.status <> 'reserved' then
    return next public.habit_reminder_summary(r); return;
  end if;
  -- Finishing needs the authenticated reserving sender, but intentionally does
  -- not recheck sharing or take any profile lock AFTER this reminder row lock.
  -- Revocation must not erase an outcome for a send authorized before it.
  if jsonb_typeof(p_results) is distinct from 'array' then
    return next jsonb_build_object('error', 'invalid_reminder_results'); return;
  end if;
  if jsonb_array_length(p_results) <> r.device_count then
    return next jsonb_build_object('error', 'invalid_reminder_results'); return;
  end if;
  for item in select value from jsonb_array_elements(p_results) loop
    if jsonb_typeof(item) is distinct from 'object' then
      return next jsonb_build_object('error', 'invalid_reminder_results'); return;
    end if;
    if not item ?& array['device_id', 'status', 'ticket_id']
        or (select count(*) from jsonb_object_keys(item)) <> 3
        or jsonb_typeof(item->'device_id') is distinct from 'string'
        or item->>'device_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'status') is distinct from 'string'
        or item->>'status' not in ('accepted', 'rejected', 'unknown', 'invalid_token') then
      return next jsonb_build_object('error', 'invalid_reminder_results'); return;
    end if;
    device_id = (item->>'device_id')::uuid;
    if device_id = any(seen) or not exists(
        select 1 from jsonb_array_elements(r.devices) d where d->>'id' = device_id::text
      ) or (item->>'status' = 'accepted' and (
        jsonb_typeof(item->'ticket_id') is distinct from 'string'
        or char_length(btrim(item->>'ticket_id')) not between 1 and 256
      )) or (item->>'status' <> 'accepted' and item->'ticket_id' is distinct from 'null'::jsonb) then
      return next jsonb_build_object('error', 'invalid_reminder_results'); return;
    end if;
    seen = array_append(seen, device_id);
    case item->>'status'
      when 'accepted' then accepted = accepted + 1;
      when 'unknown' then unknown = unknown + 1;
      else failed = failed + 1;
    end case;
  end loop;

  -- Only delete the exact registration snapshot reported invalid. A concurrent
  -- account transfer or refresh changes user_id/updated_at and survives. Sort
  -- device writes consistently when two reminders finish concurrently.
  for item in select value from jsonb_array_elements(r.devices) order by value->>'id' loop
    if exists(select 1 from jsonb_array_elements(p_results) result
        where result->>'device_id' = item->>'id' and result->>'status' = 'invalid_token') then
      delete from public.device_push_tokens where id = (item->>'id')::uuid and user_id = r.owner_id
        and expo_push_token = item->>'expo_push_token' and updated_at = (item->>'updated_at')::timestamptz;
    end if;
  end loop;
  update public.habit_reminders set
    status = case when accepted = r.device_count then 'provider_accepted'
      when accepted > 0 then 'partially_accepted' when unknown > 0 then 'unknown' else 'failed' end,
    finished_at = greatest(public.occurrence_now(), reserved_at), results = p_results,
    accepted_count = accepted, failed_count = failed, unknown_count = unknown
    where id = r.id returning * into r;
  return next public.habit_reminder_summary(r);
end;
$$;

-- Supabase default grants must never expose the table, helper, or entry points
-- to direct client roles. Only authenticated backend code supplies identities.
revoke execute on function public.habit_reminder_summary(public.habit_reminders)
  from public, anon, authenticated, service_role;
revoke execute on function public.register_device(uuid,text,text),
  public.reserve_habit_reminder(uuid,uuid,text), public.finish_habit_reminder(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.register_device(uuid,text,text),
  public.reserve_habit_reminder(uuid,uuid,text), public.finish_habit_reminder(uuid,uuid,jsonb)
  to service_role;
