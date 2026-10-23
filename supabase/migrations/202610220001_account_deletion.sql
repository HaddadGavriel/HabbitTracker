-- Recoverable deletion. No HTTP operation is assumed to share this transaction.
create table public.account_deletions (
  user_id uuid primary key,
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','complete')),
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((state = 'complete') = (completed_at is not null))
);
alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from public, anon, authenticated, service_role;

-- Shared transaction barrier precedes existing profile -> domain -> device locks.
-- Only deletion takes it exclusively. This closes candidate-discovery races,
-- including accounts without profiles, without holding any lock across HTTP.
create function public.account_write_barrier(p_users uuid[]) returns void
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock_shared(772422001);
  if exists(select 1 from public.account_deletions where user_id = any(p_users)) then
    raise exception 'account_deletion_pending';
  end if;
end;
$$;
revoke all on function public.account_write_barrier(uuid[]) from public, anon, authenticated, service_role;

-- Wrap the 31 reviewed application RPCs, including read RPCs that reconcile or
-- materialize occurrences. Internal implementations lose all API-role access.
-- Nested calls take the same reentrant shared barrier before existing locks.
do $wrap$
declare f record; names text[]; calls text; users text; body text; wrapped integer = 0;
begin
  for f in select p.*, pg_get_function_arguments(p.oid) args,
      pg_get_function_identity_arguments(p.oid) identity_args,
      pg_get_function_result(p.oid) result_type
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and has_function_privilege('service_role',p.oid,'EXECUTE')
      and p.prorettype <> 'trigger'::regtype
      -- Do not modify extension/vendor functions installed in public.
      and p.proname = any(array[
        'register_device',
        'register_device_intent',
        'unregister_device',
        'send_friend_request',
        'accept_friend_request',
        'reject_friend_request',
        'remove_friend',
        'list_friend_requests',
        'list_friends',
        'create_habit',
        'update_habit',
        'archive_habit',
        'restore_habit',
        'get_habit',
        'list_habits',
        'grant_habit_share',
        'revoke_habit_share',
        'list_habit_shares',
        'get_shared_habit',
        'list_shared_habits',
        'get_today',
        'mutate_occurrence',
        'submit_occurrence_excuse',
        'decide_occurrence_excuse',
        'get_occurrence_excuse',
        'list_pending_excuses',
        'get_habit_history',
        'get_habit_streak',
        'get_local_reminder_plan',
        'reserve_habit_reminder',
        'finish_habit_reminder'
      ])
  loop
    names = f.proargnames[1:f.pronargs];
    select string_agg(quote_ident(x), ',') into calls from unnest(names) x;
    select string_agg(quote_ident(x), ',') into users from unnest(names) x
      where x in ('p_user','p_owner','p_actor','p_requester','p_recipient','p_sender','p_friend');
    -- All existing service RPCs have named IN arguments.
    execute format('alter function public.%I(%s) rename to %I', f.proname, f.identity_args, '_deletion_impl_'||f.proname);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role', '_deletion_impl_'||f.proname, f.identity_args);
    if f.proretset then
      body = format('return query select * from public.%I(%s);', '_deletion_impl_'||f.proname, calls);
    else
      body = format('return public.%I(%s);', '_deletion_impl_'||f.proname, calls);
    end if;
    execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path = %L as %L',
      f.proname,f.args,f.result_type,'',
      'begin perform public.account_write_barrier(array['||coalesce(users,'')||']::uuid[]); '||body||' end;');
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated; grant execute on function public.%I(%s) to service_role', f.proname,f.identity_args,f.proname,f.identity_args);
    wrapped = wrapped + 1;
  end loop;
  if wrapped <> 31 then raise exception 'account_deletion_rpc_inventory_mismatch'; end if;
end;
$wrap$;

-- Direct backend writes are limited to profiles and the infrastructure probe.
-- Statement-level locking comes before row locks; row checks prevent resurrection.
create function public.account_direct_barrier() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.account_write_barrier('{}'::uuid[]);
  return null;
end;
$$;
create function public.account_direct_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.account_write_barrier(array[new.user_id]);
  return new;
end;
$$;
create trigger account_profiles_barrier before insert or update on public.profiles
for each statement execute function public.account_direct_barrier();
create trigger account_profiles_guard before insert or update on public.profiles
for each row execute function public.account_direct_guard();
create trigger account_probe_barrier before insert or update on public.infrastructure_tests
for each statement execute function public.account_direct_barrier();
create trigger account_probe_guard before insert or update on public.infrastructure_tests
for each row execute function public.account_direct_guard();
revoke all on function public.account_direct_barrier(), public.account_direct_guard() from public,anon,authenticated,service_role;

alter table public.occurrence_excuses drop constraint occurrence_excuses_decision_source_check;
alter table public.occurrence_excuses add constraint occurrence_excuses_decision_source_check
  check (decision_source in ('automatic','friend','deleted_friend'));
alter table public.occurrence_excuses drop constraint occurrence_excuses_decision_valid;
alter table public.occurrence_excuses add constraint occurrence_excuses_decision_valid check ((
  (status='pending' and decision_source is null and decided_by is null and decided_at is null)
  or (status='approved' and decision_source='automatic' and decided_by is null and decided_at is not null)
  or (status in ('approved','rejected') and decision_source='friend' and decided_by is not null and decided_at is not null)
  or (status in ('approved','rejected') and decision_source='deleted_friend' and decided_by is null and decided_at is not null)
) is true);

create or replace function public.guard_excuse_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- A durable pending request is the cleanup capability. No GUC, client flag,
  -- fake profile, timestamp rewrite, or general finalized-record bypass.
  if old.status in ('approved','rejected') and old.decision_source='friend'
      and new.decision_source='deleted_friend' and new.decided_by is null
      and (to_jsonb(new) - 'decision_source' - 'decided_by') =
          (to_jsonb(old) - 'decision_source' - 'decided_by')
      and exists(select 1 from public.account_deletions where user_id=old.decided_by and state='pending') then
    return new;
  end if;
  if (new.id,new.occurrence_id,new.explanation,new.created_at)
      is distinct from (old.id,old.occurrence_id,old.explanation,old.created_at) then
    raise exception 'immutable_excuse';
  end if;
  if old.status <> 'pending' or new.status not in ('approved','rejected')
      or new.decision_source is distinct from 'friend' or new.decided_by is null then
    raise exception 'excuse_already_decided';
  end if;
  new.decided_at = public.occurrence_now();
  return new;
end;
$$;

create function public.begin_account_deletion(p_user uuid, p_hash text) returns text
language plpgsql security definer set search_path = '' as $$
declare existing public.account_deletions;
begin
  perform pg_advisory_xact_lock(772422001);
  select * into existing from public.account_deletions where user_id=p_user;
  if found then
    if existing.receipt_hash <> p_hash then raise exception 'deletion_receipt_conflict'; end if;
    return existing.state;
  end if;
  perform 1 from auth.users where id=p_user for update;
  if not found then raise exception 'account_not_found'; end if;
  perform public.lock_share_profiles(array[p_user]);
  insert into public.account_deletions(user_id,receipt_hash) values(p_user,p_hash);
  -- The exclusive barrier drains all old RPC transactions before cleanup, and
  -- blocks new RPC discovery until pending is committed. No extra owner locks
  -- can be discovered out of UUID order during this transaction.
  update public.occurrence_excuses set decided_by=null,decision_source='deleted_friend'
    where decided_by=p_user;
  -- Do not update occurrences: finalized states, timestamps and streak inputs
  -- belong to their owners and survive deciding-friend anonymization unchanged.
  delete from public.habit_reminders where sender_id=p_user or owner_id=p_user;
  delete from public.friend_relationships where requester_id=p_user or recipient_id=p_user;
  delete from public.habits where owner_id=p_user;
  delete from public.device_push_tokens where user_id=p_user;
  delete from public.device_registration_intents where user_id=p_user;
  delete from public.infrastructure_tests where user_id=p_user;
  -- Keep the pending profile until Auth deletion. A failed Auth request cannot
  -- silently send the account to onboarding; the permanent ledger also fences it.
  return 'pending';
end;
$$;
create function public.account_deletion_status(p_hash text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('user_id',user_id,'state',state)
  from public.account_deletions where receipt_hash=p_hash;
$$;
create function public.complete_account_deletion(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(772422001);
  if exists(select 1 from auth.users where id=p_user) then raise exception 'auth_deletion_unconfirmed'; end if;
  update public.account_deletions set state='complete',completed_at=coalesce(completed_at,clock_timestamp())
    where user_id=p_user;
  if not found then raise exception 'deletion_not_found'; end if;
  return 'complete';
end;
$$;
create function public.pending_account_deletions() returns setof uuid
language sql security definer set search_path = '' as $$
  select user_id from public.account_deletions where state='pending' order by requested_at;
$$;
create function public.account_is_deleting(p_user uuid) returns boolean
language sql security definer set search_path = '' as $$
  select exists(select 1 from public.account_deletions where user_id=p_user);
$$;
revoke all on function public.begin_account_deletion(uuid,text),public.account_deletion_status(text),
  public.complete_account_deletion(uuid),public.pending_account_deletions(),public.account_is_deleting(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_account_deletion(uuid,text),public.account_deletion_status(text),
  public.complete_account_deletion(uuid),public.pending_account_deletions(),public.account_is_deleting(uuid)
  to service_role;
