-- Product milestone 2: backend-managed friend requests and mutual friendships.
create table public.friend_relationships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  recipient_id uuid not null references public.profiles(user_id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint friend_relationships_not_self check (requester_id <> recipient_id),
  constraint friend_relationships_accepted_at check (
    (state = 'pending' and accepted_at is null) or
    (state = 'accepted' and accepted_at is not null)
  )
);

-- Expression uniqueness makes direction irrelevant, including under concurrency.
create unique index friend_relationships_unordered_pair_key
  on public.friend_relationships (least(requester_id, recipient_id), greatest(requester_id, recipient_id));
create index friend_relationships_requester_state_idx on public.friend_relationships (requester_id, state);
create index friend_relationships_recipient_state_idx on public.friend_relationships (recipient_id, state);

alter table public.friend_relationships enable row level security;
revoke all on table public.friend_relationships from public, anon, authenticated;

create function public.relationship_view(r public.friend_relationships, actor uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select r.id,
    case when r.requester_id = actor then 'outgoing' else 'incoming' end,
    r.state,
    jsonb_build_object('user_id', p.user_id, 'username', p.username, 'display_name', p.display_name),
    r.created_at, r.updated_at, r.accepted_at
  from public.profiles p
  where p.user_id = case when r.requester_id = actor then r.recipient_id else r.requester_id end
$$;

create function public.send_friend_request(p_requester uuid, p_recipient uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language plpgsql security definer set search_path = ''
as $$
declare r public.friend_relationships;
begin
  if p_requester = p_recipient then raise exception using errcode = 'P0001', message = 'self_request'; end if;
  if not exists (select 1 from public.profiles where user_id = p_recipient) then
    raise exception using errcode = 'P0001', message = 'recipient_not_found';
  end if;
  begin
    insert into public.friend_relationships(requester_id, recipient_id)
      values (p_requester, p_recipient) returning * into r;
  exception when unique_violation then
    select * into r from public.friend_relationships
      where least(requester_id, recipient_id) = least(p_requester, p_recipient)
        and greatest(requester_id, recipient_id) = greatest(p_requester, p_recipient);
    if r.state = 'accepted' then raise exception using errcode = 'P0001', message = 'friendship_exists'; end if;
    if r.requester_id = p_requester then raise exception using errcode = 'P0001', message = 'outgoing_request_exists'; end if;
    raise exception using errcode = 'P0001', message = 'incoming_request_exists';
  when foreign_key_violation then
    raise exception using errcode = 'P0001', message = 'recipient_not_found';
  end;
  return query select * from public.relationship_view(r, p_requester);
end
$$;

create function public.list_friend_requests(p_user uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select v.* from public.friend_relationships r
  cross join lateral public.relationship_view(r, p_user) v
  where r.state = 'pending' and p_user in (r.requester_id, r.recipient_id)
  order by r.created_at, r.id
$$;

create function public.accept_friend_request(p_request uuid, p_actor uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language plpgsql security definer set search_path = ''
as $$
declare r public.friend_relationships;
begin
  update public.friend_relationships
    set state = 'accepted', accepted_at = now(), updated_at = now()
    where friend_relationships.id = p_request and recipient_id = p_actor and friend_relationships.state = 'pending'
    returning * into r;
  if not found then return; end if;
  return query select * from public.relationship_view(r, p_actor);
end
$$;

create function public.reject_friend_request(p_request uuid, p_actor uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.friend_relationships
    where id = p_request and recipient_id = p_actor and state = 'pending';
  return found;
end
$$;

create function public.list_friends(p_user uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select v.* from public.friend_relationships r
  cross join lateral public.relationship_view(r, p_user) v
  where r.state = 'accepted' and p_user in (r.requester_id, r.recipient_id)
  order by (v.profile->>'username'), r.id
$$;

create function public.remove_friend(p_actor uuid, p_friend uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.friend_relationships where state = 'accepted'
    and ((requester_id = p_actor and recipient_id = p_friend)
      or (requester_id = p_friend and recipient_id = p_actor));
  return found;
end
$$;

-- Supabase may grant function execution to its API roles through ALTER DEFAULT
-- PRIVILEGES. Revoke each role explicitly; revoking PUBLIC alone does not remove
-- a grant made directly to anon or authenticated.
revoke all on function public.relationship_view(public.friend_relationships, uuid) from public, anon, authenticated, service_role;
revoke all on function public.send_friend_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_friend_requests(uuid) from public, anon, authenticated;
revoke all on function public.accept_friend_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reject_friend_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_friends(uuid) from public, anon, authenticated;
revoke all on function public.remove_friend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.send_friend_request(uuid, uuid) to service_role;
grant execute on function public.list_friend_requests(uuid) to service_role;
grant execute on function public.accept_friend_request(uuid, uuid) to service_role;
grant execute on function public.reject_friend_request(uuid, uuid) to service_role;
grant execute on function public.list_friends(uuid) to service_role;
grant execute on function public.remove_friend(uuid, uuid) to service_role;
