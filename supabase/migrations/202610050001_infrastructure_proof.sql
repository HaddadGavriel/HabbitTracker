-- Minimal schema for the end-to-end infrastructure proof. Apply with `supabase db push`.
create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  platform text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index device_push_tokens_user_updated_idx
  on public.device_push_tokens (user_id, updated_at desc);

create table public.infrastructure_tests (
  request_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_started_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  database_verified_at timestamptz,
  push_requested_at timestamptz,
  expo_ticket_id text,
  status text not null check (status in ('received', 'database_verified', 'push_accepted', 'push_failed')),
  created_at timestamptz not null default now()
);

create index infrastructure_tests_user_created_idx
  on public.infrastructure_tests (user_id, created_at desc);

alter table public.device_push_tokens enable row level security;
alter table public.infrastructure_tests enable row level security;

-- No client policies are intentional. Only the service-role backend can access these
-- tables; the mobile app must go through authenticated FastAPI endpoints.
