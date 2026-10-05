-- Product milestone 1: backend-managed user profiles.
create table public.profiles (
  user_id uuid primary key constraint profiles_user_id_fkey references auth.users(id) on delete cascade,
  username text not null constraint profiles_username_key unique,
  display_name text not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_canonical check (
    username = lower(btrim(username))
    and char_length(username) between 3 and 30
    and username ~ '^[a-z0-9_]+$'
  ),
  constraint profiles_display_name_valid check (
    display_name = btrim(display_name) and char_length(display_name) between 1 and 80
  )
);

create function public.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_profile_updated_at();

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;

-- No client policies are intentional. The backend secret key is the only profile
-- access path; identity is obtained from the separately validated Auth token.
