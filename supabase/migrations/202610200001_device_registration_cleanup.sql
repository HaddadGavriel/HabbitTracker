-- A client journals an intent UUID before registration so even a lost response
-- can be cancelled. These credential-free tombstones also fence delayed POSTs.
alter table public.device_push_tokens
  add column registration_id uuid not null default gen_random_uuid();
create table public.device_registration_intents (
  user_id uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null,
  primary key (user_id, registration_id)
);
alter table public.device_registration_intents enable row level security;
revoke all on public.device_registration_intents from public, anon, authenticated, service_role;

-- Keep the legacy RPC signature for compatibility, but rotate identity on every
-- legacy refresh/transfer too. Its strictly increasing version still protects
-- reminder invalid-token finalization, without changing reservation semantics.
create or replace function public.register_device(p_user uuid, p_token text, p_platform text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare registered_at timestamptz;
begin
  if p_token is null or char_length(p_token) > 256
      or p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
      or p_platform is null or p_platform not in ('android', 'ios') then
    raise exception using errcode = 'P0001', message = 'invalid_device_registration';
  end if;
  insert into public.device_push_tokens as devices(user_id, expo_push_token, platform, updated_at)
    values(p_user, p_token, p_platform, public.occurrence_now())
    on conflict (expo_push_token) do update
      set user_id = excluded.user_id, platform = excluded.platform,
        registration_id = gen_random_uuid(),
        updated_at = greatest(public.occurrence_now(), devices.updated_at + interval '1 microsecond')
    returning updated_at into registered_at;
  return registered_at;
end;
$$;

create function public.register_device_intent(p_user uuid, p_token text, p_platform text, p_registration uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare registered_at timestamptz;
begin
  if p_registration is null then raise exception 'invalid_device_registration'; end if;
  -- Same lock in unregister: cancellation wins even if the HTTP register request
  -- only reaches PostgreSQL after logout. No lock is held across an Expo call.
  perform pg_advisory_xact_lock(hashtextextended(p_registration::text, 0));
  insert into public.device_registration_intents values(p_user, p_registration)
    on conflict do nothing;
  if not found then
    -- An idempotent replay can observe its original result, never reacquire a
    -- token transferred/refreshed since that intent (including transfer back).
    select updated_at into registered_at from public.device_push_tokens
      where user_id = p_user and registration_id = p_registration;
    return registered_at;
  end if;
  registered_at = public.register_device(p_user, p_token, p_platform);
  update public.device_push_tokens set registration_id = p_registration
    where expo_push_token = p_token and user_id = p_user;
  return registered_at;
end;
$$;

create function public.unregister_device(p_user uuid, p_registration uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_registration is null then raise exception 'invalid_device_registration'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_registration::text, 0));
  insert into public.device_registration_intents values(p_user, p_registration)
    on conflict do nothing;
  delete from public.device_push_tokens
    where user_id = p_user and registration_id = p_registration;
  return found;
end;
$$;

revoke all on function public.register_device(uuid,text,text) from public, anon, authenticated;
revoke all on function public.register_device_intent(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.unregister_device(uuid,uuid) from public, anon, authenticated;
grant execute on function public.register_device(uuid,text,text) to service_role;
grant execute on function public.register_device_intent(uuid,text,text,uuid) to service_role;
grant execute on function public.unregister_device(uuid,uuid) to service_role;
