-- Public owner identity travels with the authorized excuse, including final
-- decisions. Keep this helper private: the existing RPCs check current access
-- and hold the owner/share locks before rendering any excuse details.
create or replace function public.excuse_view(e public.occurrence_excuses)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(e) || jsonb_build_object(
    'habit_id', o.habit_id,
    'owner_id', o.owner_id,
    'owner', jsonb_build_object(
      'user_id', p.user_id, 'display_name', p.display_name, 'username', p.username),
    'occurrence', to_jsonb(o))
  from public.habit_occurrences o
  join public.profiles p on p.user_id = o.owner_id
  where o.id = e.occurrence_id;
$$;

revoke all on function public.excuse_view(public.occurrence_excuses)
  from public, anon, authenticated, service_role;
