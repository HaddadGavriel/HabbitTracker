-- Preserve applied migrations. A pair may disappear between a conflicting
-- INSERT and conflict classification (concurrent reject/remove), so retry it.
create or replace function public.send_friend_request(p_requester uuid, p_recipient uuid)
returns table (
  id uuid, direction text, state text, profile jsonb,
  created_at timestamptz, updated_at timestamptz, accepted_at timestamptz
)
language plpgsql security definer set search_path = ''
as $$
declare r public.friend_relationships;
begin
  if p_requester = p_recipient then
    raise exception using errcode = 'P0001', message = 'self_request';
  end if;

  -- Keep both profiles alive until this operation ends. Missing actors must
  -- not be misreported as missing recipients after the API's onboarding check.
  perform 1 from public.profiles where user_id = p_requester for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'profile_not_found';
  end if;
  perform 1 from public.profiles where user_id = p_recipient for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'recipient_not_found';
  end if;

  loop
    insert into public.friend_relationships as relationships (requester_id, recipient_id)
      values (p_requester, p_recipient)
      on conflict (least(requester_id, recipient_id), greatest(requester_id, recipient_id))
      do nothing
      returning relationships.* into r;
    if found then
      return query select * from public.relationship_view(r, p_requester);
      return;
    end if;

    select relationships.* into r from public.friend_relationships relationships
      where least(relationships.requester_id, relationships.recipient_id) = least(p_requester, p_recipient)
        and greatest(relationships.requester_id, relationships.recipient_id) = greatest(p_requester, p_recipient)
      for update;
    -- READ COMMITTED gives each statement a fresh snapshot. If the conflicting
    -- row was deleted, the next INSERT can create the newly permitted request.
    if not found then continue; end if;
    if r.state = 'accepted' then
      raise exception using errcode = 'P0001', message = 'friendship_exists';
    elsif r.requester_id = p_requester then
      raise exception using errcode = 'P0001', message = 'outgoing_request_exists';
    else
      raise exception using errcode = 'P0001', message = 'incoming_request_exists';
    end if;
  end loop;
end
$$;

-- CREATE OR REPLACE preserves privileges; repeat them explicitly for clarity.
revoke all on function public.send_friend_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.send_friend_request(uuid, uuid) to service_role;
