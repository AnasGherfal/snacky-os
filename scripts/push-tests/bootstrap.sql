-- Disposable CI database only; never run this bootstrap against production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table public.profiles(id uuid primary key, active_status text not null);
create table public.routes(id uuid primary key);
