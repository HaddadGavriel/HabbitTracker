-- Disposable empty PostgreSQL only; deliberately not a Supabase emulator.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
grant usage on schema public to anon, authenticated, service_role;
-- Exercise migrations under Supabase-like default API grants.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
