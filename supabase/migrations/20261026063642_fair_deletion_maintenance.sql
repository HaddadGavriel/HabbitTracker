-- Retry ordering survives cron process restarts. Claims only select deletions
-- already authorized by begin_account_deletion; they cannot initiate deletion.
alter table public.account_deletions
  add column maintenance_attempted_at timestamptz not null default '-infinity',
  add column maintenance_lease_until timestamptz not null default '-infinity';

create index account_deletions_maintenance_pending_idx
  on public.account_deletions(maintenance_attempted_at, requested_at, user_id)
  where state = 'pending';

create function public.claim_account_deletions(p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  selected uuid[];
  pending_count bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_maintenance_limit';
  end if;
  select count(*) into pending_count from public.account_deletions where state = 'pending';
  with candidates as (
    select user_id from public.account_deletions
    where state = 'pending' and maintenance_lease_until <= statement_timestamp()
    order by maintenance_attempted_at, requested_at, user_id
    limit p_limit for update skip locked
  ), claimed as (
    update public.account_deletions d
    set maintenance_attempted_at = statement_timestamp(),
        maintenance_lease_until = statement_timestamp() + interval '5 minutes'
    from candidates c where d.user_id = c.user_id
    returning d.user_id
  )
  select coalesce(array_agg(user_id order by user_id), '{}'::uuid[]) into selected from claimed;
  -- Scalar JSON is not truncated by the Data API's set-returning row limit.
  return jsonb_build_object('user_ids', selected, 'pending_count', pending_count);
end;
$$;

create function public.account_deletion_pending_count()
returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from public.account_deletions where state = 'pending';
$$;

revoke all on function public.claim_account_deletions(integer),
  public.account_deletion_pending_count() from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletions(integer),
  public.account_deletion_pending_count() to service_role;
