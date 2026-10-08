-- Durable, single-submission excuses. Live sharing controls access; recipients
-- are deliberately not snapshotted, so revocation and new grants apply at once.
alter table public.habit_occurrences drop constraint habit_occurrences_state_check;
alter table public.habit_occurrences add constraint habit_occurrences_state_check
  check (state in ('in_progress', 'completed', 'missed', 'justification_pending', 'excused'));

-- Match Python str.strip's Unicode whitespace set, independently of database
-- locale. PostgreSQL char_length counts code points, including supplementary
-- characters; UTF-8 text already excludes NUL and malformed Unicode.
create function public.normalize_excuse_explanation(p_text text)
returns text language sql immutable set search_path = '' as $$
  select btrim(p_text, U&'\0009\000A\000B\000C\000D\001C\001D\001E\001F\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000');
$$;

create table public.occurrence_excuses (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null unique references public.habit_occurrences(id) on delete cascade,
  explanation text not null check (
    explanation = public.normalize_excuse_explanation(explanation)
    and char_length(explanation) between 1 and 1000
  ),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  decision_source text check (decision_source in ('automatic', 'friend')),
  -- Keep the recorded deciding identity durable. Removing a friendship does not
  -- remove its profile and therefore never affects this audit record.
  decided_by uuid references public.profiles(user_id) on delete no action deferrable initially deferred,
  decided_at timestamptz,
  created_at timestamptz not null default public.occurrence_now(),
  constraint occurrence_excuses_decision_valid check ((
    (status = 'pending' and decision_source is null and decided_by is null and decided_at is null)
    or (status = 'approved' and decision_source = 'automatic' and decided_by is null and decided_at is not null)
    or (status in ('approved', 'rejected') and decision_source = 'friend' and decided_by is not null and decided_at is not null)
  ) is true),
  check (decided_at is null or decided_at >= created_at)
);
create index occurrence_excuses_pending_order_idx on public.occurrence_excuses(created_at, id)
  where status = 'pending';
alter table public.occurrence_excuses enable row level security;
revoke all on public.occurrence_excuses from public, anon, authenticated, service_role;

create function public.guard_excuse_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.occurrence_id, new.explanation, new.created_at)
      is distinct from (old.id, old.occurrence_id, old.explanation, old.created_at) then
    raise exception 'immutable_excuse';
  end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected')
      or new.decision_source is distinct from 'friend' or new.decided_by is null then
    raise exception 'excuse_already_decided';
  end if;
  new.decided_at = public.occurrence_now();
  return new;
end;
$$;
create trigger excuses_guard_update before update on public.occurrence_excuses
for each row execute function public.guard_excuse_update();

-- This helper deliberately ignores archival: a valid grant still makes an
-- owner's submission shared while archived. Recipient entry points separately
-- require an active habit before allowing either reads or decisions.
create function public.is_current_habit_recipient(p_owner uuid, p_habit uuid, p_recipient uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_owner <> p_recipient and exists (
    select 1 from public.habit_shares s
    join public.friend_relationships r on r.id = s.relationship_id
    where s.owner_id = p_owner and s.habit_id = p_habit and s.recipient_id = p_recipient
      and r.state = 'accepted'
      and ((r.requester_id = s.owner_id and r.recipient_id = s.recipient_id)
        or (r.requester_id = s.recipient_id and r.recipient_id = s.owner_id))
  );
$$;

create function public.excuse_view(e public.occurrence_excuses)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(e) || jsonb_build_object('habit_id', o.habit_id, 'owner_id', o.owner_id,
    'occurrence', to_jsonb(o)) from public.habit_occurrences o where o.id = e.occurrence_id;
$$;

-- The protected durable excuse record is the capability for exceptional state
-- transitions. No client-controlled session setting can bypass the midnight
-- guard. RPCs write that record and its occurrence in one transaction, after
-- ownership/current-sharing checks. Normal progress never changes this record.
create or replace function public.guard_occurrence_update() returns trigger
language plpgsql set search_path = '' as $$
declare n timestamptz; e public.occurrence_excuses;
begin
  n = public.occurrence_now();
  if (new.id,new.habit_id,new.owner_id,new.local_date,new.timezone,new.closes_at,new.snapshot,new.created_at)
     is distinct from (old.id,old.habit_id,old.owner_id,old.local_date,old.timezone,old.closes_at,old.snapshot,old.created_at) then
    raise exception 'immutable_occurrence';
  end if;
  select * into e from public.occurrence_excuses where occurrence_id = old.id;
  if old.state = 'justification_pending' then
    if (new.progress, new.completed) is not distinct from (old.progress, old.completed)
        and e.decision_source = 'friend' and e.decided_by is not null and e.decided_at is not null
        and ((new.state = 'excused' and e.status = 'approved')
          or (new.state = 'missed' and e.status = 'rejected')) then
      new.updated_at = n;
      return new;
    end if;
    raise exception 'occurrence_locked';
  end if;
  if old.state = 'excused' or (old.state = 'missed' and e.id is not null) then
    raise exception 'occurrence_locked';
  end if;
  -- Preserve PR #9: even unchanged completion/progress assignments after the
  -- deadline fail. Only unchanged in_progress -> missed reconciliation passes.
  if n >= old.closes_at and (
      old.state = 'in_progress' and new.state = 'missed'
      and (new.progress, new.completed) is not distinct from (old.progress, old.completed)
    ) is not true then
    raise exception 'occurrence_closed';
  end if;
  if old.state = 'in_progress' and new.state in ('justification_pending', 'excused') then
    if (new.progress, new.completed) is not distinct from (old.progress, old.completed)
        and not new.completed and (
          (new.state = 'justification_pending' and e.status = 'pending')
          or (new.state = 'excused' and e.status = 'approved' and e.decision_source = 'automatic')
        ) then
      new.updated_at = n;
      return new;
    end if;
    raise exception 'invalid_occurrence_state';
  end if;
  if old.state = 'missed' and new.state <> old.state then raise exception 'occurrence_closed'; end if;
  if new.state is distinct from (case when new.completed then 'completed'
      when n >= old.closes_at then 'missed' else 'in_progress' end) then
    raise exception 'invalid_occurrence_state';
  end if;
  new.updated_at = n;
  return new;
end;
$$;

create function public.submit_occurrence_excuse(p_owner uuid, p_occurrence uuid, p_explanation text)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare o public.habit_occurrences; e public.occurrence_excuses; explanation text; shared boolean; n timestamptz;
begin
  -- An owner-only lock is sufficient: every grant/revoke/removal involving this
  -- owner acquires the same profile lock before modifying relationships/grants.
  -- Never acquire recipient locks after this lock. Reconciliation follows the
  -- established profile -> occurrence order and leaves pending/excused intact.
  perform public.require_habit_profile(p_owner);
  select * into o from public.habit_occurrences where id = p_occurrence and owner_id = p_owner for update;
  if not found then return; end if;
  explanation = public.normalize_excuse_explanation(p_explanation);
  if explanation is null or char_length(explanation) not between 1 and 1000 then
    return next jsonb_build_object('error', 'invalid_excuse_explanation'); return;
  end if;
  if exists(select 1 from public.occurrence_excuses where occurrence_id = o.id) then
    return next jsonb_build_object('error', 'excuse_exists'); return;
  end if;
  n = public.occurrence_now();
  if n >= o.closes_at then
    update public.habit_occurrences set state = 'missed' where id = o.id and state = 'in_progress';
    return next jsonb_build_object('error', 'occurrence_closed'); return;
  end if;
  if o.state <> 'in_progress' then
    return next jsonb_build_object('error', 'occurrence_not_in_progress'); return;
  end if;
  select exists (
    select 1 from public.habit_shares s where s.owner_id = p_owner and s.habit_id = o.habit_id
      and public.is_current_habit_recipient(p_owner, o.habit_id, s.recipient_id)
  ) into shared;
  begin
    insert into public.occurrence_excuses(occurrence_id, explanation, status, decision_source, decided_at, created_at)
      values(o.id, explanation, case when shared then 'pending' else 'approved' end,
        case when shared then null else 'automatic' end, case when shared then null else n end, n)
      returning * into e;
    update public.habit_occurrences set state = case when shared then 'justification_pending' else 'excused' end
      where id = o.id;
  exception when raise_exception then
    if sqlerrm <> 'occurrence_closed' then raise; end if;
    -- If midnight lands between the check and the trigger, roll back BOTH the
    -- excuse insert and transition, then persist ordinary reconciliation.
    update public.habit_occurrences set state = 'missed' where id = o.id and state = 'in_progress';
    return next jsonb_build_object('error', 'occurrence_closed'); return;
  end;
  return next public.excuse_view(e);
end;
$$;

create function public.get_occurrence_excuse(p_actor uuid, p_occurrence uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; o public.habit_occurrences; e public.occurrence_excuses;
begin
  select owner_id into v_owner from public.habit_occurrences where id = p_occurrence;
  perform public.lock_share_profiles(array[p_actor, v_owner]);
  if not exists(select 1 from public.profiles where user_id = p_actor) then raise exception 'profile_not_found'; end if;
  select * into o from public.habit_occurrences where id = p_occurrence and owner_id = v_owner;
  if not found then return; end if;
  if p_actor <> o.owner_id and not (
      exists(select 1 from public.habits where id = o.habit_id and archived_at is null)
      and public.is_current_habit_recipient(o.owner_id, o.habit_id, p_actor)
    ) then return; end if;
  select * into e from public.occurrence_excuses where occurrence_id = o.id;
  if found then return next public.excuse_view(e); end if;
end;
$$;

create function public.decide_occurrence_excuse(p_actor uuid, p_excuse uuid, p_decision text)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; e public.occurrence_excuses; o public.habit_occurrences;
begin
  -- Candidate discovery is not authorization. After ALL profiles are locked in
  -- UUID order, recheck current grant, accepted relationship, and archive state.
  select o1.owner_id into v_owner from public.occurrence_excuses e1
    join public.habit_occurrences o1 on o1.id = e1.occurrence_id where e1.id = p_excuse;
  perform public.lock_share_profiles(array[p_actor, v_owner]);
  if not exists(select 1 from public.profiles where user_id = p_actor) then raise exception 'profile_not_found'; end if;
  select o1.* into o from public.habit_occurrences o1
    join public.occurrence_excuses e1 on e1.occurrence_id = o1.id
    join public.habits h on h.id = o1.habit_id
    where e1.id = p_excuse and o1.owner_id = v_owner and h.archived_at is null
      and public.is_current_habit_recipient(o1.owner_id, o1.habit_id, p_actor)
    for update of o1;
  if not found then return; end if;
  select * into strict e from public.occurrence_excuses where id = p_excuse for update;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    return next jsonb_build_object('error', 'invalid_excuse_decision'); return;
  end if;
  if e.status <> 'pending' or o.state <> 'justification_pending' then
    return next jsonb_build_object('error', 'excuse_already_decided'); return;
  end if;
  update public.occurrence_excuses set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    decision_source = 'friend', decided_by = p_actor, decided_at = public.occurrence_now()
    where id = e.id returning * into e;
  update public.habit_occurrences set state = case when p_decision = 'approve' then 'excused' else 'missed' end
    where id = o.id;
  return next public.excuse_view(e);
end;
$$;

create function public.list_pending_excuses(p_actor uuid)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare candidate_owners uuid[]; current_owners uuid[];
begin
  loop
    begin
      -- Lock every currently shared owner, even if there is no pending excuse
      -- yet: submission holds only its owner lock and could otherwise introduce
      -- an unlocked owner between the second discovery and the result query.
      select coalesce(array_agg(distinct s.owner_id), '{}'::uuid[]) into candidate_owners
        from public.habit_shares s join public.habits h on h.id = s.habit_id
        where s.recipient_id = p_actor and h.archived_at is null
          and public.is_current_habit_recipient(s.owner_id, s.habit_id, p_actor);
      perform public.lock_share_profiles(array_append(candidate_owners, p_actor));
      if not exists(select 1 from public.profiles where user_id = p_actor) then raise exception 'profile_not_found'; end if;
      select coalesce(array_agg(distinct s.owner_id), '{}'::uuid[]) into current_owners
        from public.habit_shares s join public.habits h on h.id = s.habit_id
        where s.recipient_id = p_actor and h.archived_at is null
          and public.is_current_habit_recipient(s.owner_id, s.habit_id, p_actor);
      -- New sharing/restoration can reveal another owner during
      -- discovery. Release this attempt's locks and reacquire the COMPLETE set
      -- in sorted order; never append a potentially smaller UUID while locked.
      if not current_owners <@ candidate_owners then
        raise exception using errcode = 'PHS01', message = 'retry_share_owners';
      end if;
      return query select public.excuse_view(e) from public.occurrence_excuses e
        join public.habit_occurrences o on o.id = e.occurrence_id
        join public.habits h on h.id = o.habit_id
        where e.status = 'pending' and o.state = 'justification_pending' and h.archived_at is null
          and public.is_current_habit_recipient(o.owner_id, o.habit_id, p_actor)
        order by e.created_at, e.id;
      return;
    exception when sqlstate 'PHS01' then
      null;
    end;
  end loop;
end;
$$;

-- Keep successful delta replay ahead of final-state and deadline guards. Its
-- saved response is historical and never updates an already-excused occurrence.
create or replace function public.mutate_occurrence(p_owner uuid,p_occurrence uuid,p_operation text,p_value jsonb,p_key text default null)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare o public.habit_occurrences; a public.occurrence_adjustments; v numeric; result jsonb; n timestamptz;
begin
  perform public.require_habit_profile(p_owner);
  select * into o from public.habit_occurrences where owner_id=p_owner and id=p_occurrence for update;
  if not found then return; end if;
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
  if exists(select 1 from public.occurrence_excuses where occurrence_id=o.id) then
    return next jsonb_build_object('error','occurrence_locked'); return;
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
    if sqlerrm <> 'occurrence_closed' then raise; end if;
    update public.habit_occurrences set state='missed' where id=o.id and state='in_progress';
    return next jsonb_build_object('error','occurrence_closed'); return;
  end;
  if p_operation='adjustment' then
    insert into public.occurrence_adjustments(occurrence_id,key,delta,result)
      values(o.id,p_key,(p_value #>> '{}')::numeric,result);
  end if;
  return next result;
end;
$$;

revoke execute on function public.normalize_excuse_explanation(text), public.guard_excuse_update(),
  public.is_current_habit_recipient(uuid,uuid,uuid), public.excuse_view(public.occurrence_excuses),
  public.guard_occurrence_update()
  from public, anon, authenticated, service_role;
revoke execute on function public.submit_occurrence_excuse(uuid,uuid,text), public.get_occurrence_excuse(uuid,uuid),
  public.decide_occurrence_excuse(uuid,uuid,text), public.list_pending_excuses(uuid),
  public.mutate_occurrence(uuid,uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_occurrence_excuse(uuid,uuid,text), public.get_occurrence_excuse(uuid,uuid),
  public.decide_occurrence_excuse(uuid,uuid,text), public.list_pending_excuses(uuid),
  public.mutate_occurrence(uuid,uuid,text,jsonb,text)
  to service_role;
