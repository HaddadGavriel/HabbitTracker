-- Selective, read-only sharing. A grant belongs to a particular relationship,
-- so deleting that relationship revokes both directions in the same transaction.
-- Re-friending creates a new relationship and never recreates old grants.
create table public.habit_shares (
  habit_id uuid not null,
  owner_id uuid not null,
  recipient_id uuid not null references public.profiles(user_id) on delete cascade,
  relationship_id uuid not null references public.friend_relationships(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (habit_id, recipient_id),
  foreign key (habit_id, owner_id) references public.habits(id, owner_id) on delete cascade,
  constraint habit_shares_not_self check (owner_id <> recipient_id)
);
create index habit_shares_recipient_owner_idx on public.habit_shares(recipient_id, owner_id, habit_id);
create index habit_shares_relationship_idx on public.habit_shares(relationship_id);
alter table public.habit_shares enable row level security;
revoke all on public.habit_shares from public, anon, authenticated, service_role;

-- Existing owner operations serialize through a FOR UPDATE profile lock before
-- habit/occurrence rows. Operations involving multiple people acquire ALL their
-- profile locks in UUID order, before relationships, habits, or grants. In
-- particular, never acquire a recipient lock before discovering/locking owners.
-- Holding these locks through the transaction orders sharing, revocation,
-- friendship removal, archival, progress changes, and reconciliation together.
create function public.lock_share_profiles(p_users uuid[])
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from public.profiles where user_id = any(p_users) order by user_id for update;
end;
$$;

-- Preserve friend-request conflict behavior while fixing its multi-profile lock
-- order. KEY SHARE keeps the existing lightweight lifetime protection; sorting
-- also prevents a request holding the larger UUID from blocking a sharing RPC
-- that already holds the smaller UUID and is waiting for the larger one.
create or replace function public.send_friend_request(p_requester uuid, p_recipient uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare r public.friend_relationships;
begin
  if p_requester = p_recipient then
    raise exception using errcode = 'P0001', message = 'self_request';
  end if;
  perform 1 from public.profiles where user_id in (p_requester, p_recipient)
    order by user_id for key share;
  if not exists (select 1 from public.profiles where user_id = p_requester) then
    raise exception using errcode = 'P0001', message = 'profile_not_found';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_recipient) then
    raise exception using errcode = 'P0001', message = 'recipient_not_found';
  end if;
  loop
    insert into public.friend_relationships as relationships (requester_id, recipient_id)
      values (p_requester, p_recipient)
      on conflict (least(requester_id, recipient_id), greatest(requester_id, recipient_id))
      do nothing returning relationships.* into r;
    if found then
      return query select * from public.relationship_view(r, p_requester);
      return;
    end if;
    select relationships.* into r from public.friend_relationships relationships
      where least(relationships.requester_id, relationships.recipient_id) = least(p_requester, p_recipient)
        and greatest(relationships.requester_id, relationships.recipient_id) = greatest(p_requester, p_recipient)
      for update;
    if not found then continue; end if;
    if r.state = 'accepted' then
      raise exception using errcode = 'P0001', message = 'friendship_exists';
    elsif r.requester_id = p_requester then
      raise exception using errcode = 'P0001', message = 'outgoing_request_exists';
    else
      raise exception using errcode = 'P0001', message = 'incoming_request_exists';
    end if;
  end loop;
end;
$$;

create or replace function public.remove_friend(p_actor uuid, p_friend uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_share_profiles(array[p_actor, p_friend]);
  delete from public.friend_relationships where state = 'accepted'
    and ((requester_id = p_actor and recipient_id = p_friend)
      or (requester_id = p_friend and recipient_id = p_actor));
  -- The relationship FK cascades every grant in both directions before commit.
  return found;
end;
$$;

create function public.grant_habit_share(p_owner uuid, p_habit uuid, p_recipient uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare r public.friend_relationships;
begin
  perform public.lock_share_profiles(array[p_owner, p_recipient]);
  if not exists (select 1 from public.profiles where user_id = p_owner) then
    raise exception 'profile_not_found';
  end if;
  -- Ownership precedes idempotency and recipient-specific errors; inaccessible
  -- and missing habit identifiers therefore have the same empty result.
  perform 1 from public.habits where id = p_habit and owner_id = p_owner;
  if not found then return; end if;
  if p_owner = p_recipient then raise exception 'self_share'; end if;
  select * into r from public.friend_relationships
    where state = 'accepted'
      and ((requester_id = p_owner and recipient_id = p_recipient)
        or (requester_id = p_recipient and recipient_id = p_owner))
    for update;
  if not found then raise exception 'friendship_required'; end if;
  -- Granting an archived habit is allowed; shared reads still require active.
  insert into public.habit_shares(habit_id, owner_id, recipient_id, relationship_id)
    values (p_habit, p_owner, p_recipient, r.id)
    on conflict (habit_id, recipient_id) do nothing;
  return query select jsonb_build_object('user_id', p.user_id, 'username', p.username,
    'display_name', p.display_name) from public.profiles p where p.user_id = p_recipient;
end;
$$;

create function public.revoke_habit_share(p_owner uuid, p_habit uuid, p_recipient uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_share_profiles(array[p_owner, p_recipient]);
  if not exists (select 1 from public.profiles where user_id = p_owner) then
    raise exception 'profile_not_found';
  end if;
  perform 1 from public.habits where id = p_habit and owner_id = p_owner;
  if not found then return false; end if;
  delete from public.habit_shares
    where habit_id = p_habit and owner_id = p_owner and recipient_id = p_recipient;
  return true;
end;
$$;

create function public.list_habit_shares(p_owner uuid, p_habit uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare recipients jsonb;
begin
  perform public.lock_share_profiles(array[p_owner]);
  if not exists (select 1 from public.profiles where user_id = p_owner) then
    raise exception 'profile_not_found';
  end if;
  perform 1 from public.habits where id = p_habit and owner_id = p_owner;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'username', p.username,
      'display_name', p.display_name) order by p.username, p.user_id), '[]'::jsonb)
    into recipients from public.habit_shares s
    join public.profiles p on p.user_id = s.recipient_id
    join public.friend_relationships r on r.id = s.relationship_id
    where s.habit_id = p_habit and s.owner_id = p_owner and r.state = 'accepted'
      and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
        or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id));
  return recipients;
end;
$$;

-- Explicit response allowlists keep owner identity and occurrence snapshots
-- separate from configuration and omit private profile/occurrence metadata.
-- p_today is obtained internally from get_today only after access is authorized.
create function public.shared_habit_view(h public.habits, p_today jsonb)
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
  from public.profiles p
  left join lateral (
    select value as item from jsonb_array_elements(p_today->'occurrences')
    where value->>'habit_id' = h.id::text
  ) o on true
  where p.user_id = h.owner_id;
$$;

create function public.get_shared_habit(p_recipient uuid, p_habit uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; h public.habits; owner_today jsonb;
begin
  -- This is only candidate discovery. It neither locks rows nor reconciles any
  -- owner. After ordered profile locks, a fresh statement rechecks every grant,
  -- relationship, and archive condition before get_today can write occurrences.
  select s.owner_id into v_owner from public.habit_shares s
    join public.habits candidate on candidate.id = s.habit_id and candidate.owner_id = s.owner_id
    join public.friend_relationships r on r.id = s.relationship_id
    where s.recipient_id = p_recipient and s.habit_id = p_habit and candidate.archived_at is null
      and r.state = 'accepted'
      and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
        or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id));
  perform public.lock_share_profiles(array[p_recipient, v_owner]);
  if not exists (select 1 from public.profiles where user_id = p_recipient) then
    raise exception 'profile_not_found';
  end if;
  select candidate.* into h from public.habits candidate
    join public.habit_shares s on s.habit_id = candidate.id and s.owner_id = candidate.owner_id
    join public.friend_relationships r on r.id = s.relationship_id
    where candidate.id = p_habit and candidate.owner_id = v_owner and candidate.archived_at is null
      and s.recipient_id = p_recipient and r.state = 'accepted'
      and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
        or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id));
  if not found then return; end if;
  owner_today = public.get_today(v_owner);
  return next public.shared_habit_view(h, owner_today);
end;
$$;

create function public.list_shared_habits(p_recipient uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare candidate_owners uuid[]; current_owners uuid[]; v_owner uuid; owner_today jsonb;
begin
  loop
    begin
      select coalesce(array_agg(distinct s.owner_id), '{}'::uuid[]) into candidate_owners
        from public.habit_shares s
        join public.habits h on h.id = s.habit_id and h.owner_id = s.owner_id
        join public.friend_relationships r on r.id = s.relationship_id
        where s.recipient_id = p_recipient and h.archived_at is null and r.state = 'accepted'
        and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
          or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id));
      perform public.lock_share_profiles(array_append(candidate_owners, p_recipient));
      if not exists (select 1 from public.profiles where user_id = p_recipient) then
        raise exception 'profile_not_found';
      end if;
      select coalesce(array_agg(distinct s.owner_id order by s.owner_id), '{}'::uuid[]) into current_owners
        from public.habit_shares s
        join public.habits h on h.id = s.habit_id and h.owner_id = s.owner_id
        join public.friend_relationships r on r.id = s.relationship_id
        where s.recipient_id = p_recipient and h.archived_at is null and r.state = 'accepted'
          and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
            or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id));
      -- A previously unseen owner may have granted/restored access between
      -- discovery and locking. Filtering that owner out could mix permissions
      -- from incompatible snapshots. Release this attempt's locks through the
      -- subtransaction, rediscover, and acquire the COMPLETE set in UUID order.
      -- Never lock an extra owner here: its UUID could precede a held lock.
      if not current_owners <@ candidate_owners then
        raise exception using errcode = 'PHS01', message = 'retry_share_owners';
      end if;
      foreach v_owner in array current_owners loop
        owner_today = public.get_today(v_owner);
        return query select public.shared_habit_view(h, owner_today) from public.habits h
          join public.habit_shares s on s.habit_id = h.id and s.owner_id = h.owner_id
          join public.friend_relationships r on r.id = s.relationship_id
          where s.recipient_id = p_recipient and h.owner_id = v_owner
            and h.archived_at is null and r.state = 'accepted'
            and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
              or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id))
          order by h.created_at, h.id;
      end loop;
      return;
    exception when sqlstate 'PHS01' then
      -- No reconciliation or results were produced by the aborted attempt.
      null;
    end;
  end loop;
end;
$$;

revoke execute on function public.lock_share_profiles(uuid[]), public.shared_habit_view(public.habits,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.grant_habit_share(uuid,uuid,uuid), public.revoke_habit_share(uuid,uuid,uuid),
  public.list_habit_shares(uuid,uuid), public.get_shared_habit(uuid,uuid), public.list_shared_habits(uuid),
  public.send_friend_request(uuid,uuid), public.remove_friend(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.grant_habit_share(uuid,uuid,uuid), public.revoke_habit_share(uuid,uuid,uuid),
  public.list_habit_shares(uuid,uuid), public.get_shared_habit(uuid,uuid), public.list_shared_habits(uuid),
  public.send_friend_request(uuid,uuid), public.remove_friend(uuid,uuid)
  to service_role;
