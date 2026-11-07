-- :\ARCHITECT\ hosted state: runs, their event logs and their files (evidence, handoff notes).
-- Tables live in the `architect` schema with row-level security on and no client policies.
-- The only way in is the public.architect_* functions below, which only the service role
-- (held by the Architect Worker as a secret) may call. The schema itself is never exposed
-- to the API, so the shared project's API settings stay unchanged.

create schema if not exists architect;
revoke all on schema architect from public, anon, authenticated;

create table if not exists architect.runs (
  id text primary key check (id ~ '^run_[a-z0-9]+$'),
  status text not null,
  goal text not null,
  data jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists runs_created_at_idx on architect.runs (created_at desc);

create table if not exists architect.events (
  id bigint generated always as identity primary key,
  run_id text not null references architect.runs (id) on delete cascade,
  type text not null,
  data jsonb not null,
  at timestamptz not null
);
create index if not exists events_run_idx on architect.events (run_id, id);

create table if not exists architect.files (
  run_id text not null references architect.runs (id) on delete cascade,
  path text not null check (path !~ '(^/|\.\.)'),
  content bytea not null,
  updated_at timestamptz not null default now(),
  primary key (run_id, path)
);

alter table architect.runs enable row level security;
alter table architect.events enable row level security;
alter table architect.files enable row level security;
revoke all on all tables in schema architect from public, anon, authenticated;

-- Insert or replace a run (the whole run is the JSON document).
create or replace function public.architect_save_run(p_run jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into architect.runs (id, status, goal, data, created_at, updated_at)
  values (p_run->>'id', p_run->>'status', p_run->'score'->>'goal', p_run, (p_run->>'createdAt')::timestamptz, now())
  on conflict (id) do update
    set status = excluded.status, goal = excluded.goal, data = excluded.data, updated_at = now();
$$;

create or replace function public.architect_get_run(p_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select data from architect.runs where id = p_id;
$$;

create or replace function public.architect_list_runs(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(data order by created_at desc), '[]'::jsonb)
  from (select data, created_at from architect.runs where data ? 'score' order by created_at desc limit least(greatest(p_limit, 1), 500)) r;
$$;

-- Events may arrive before the first save of their run; keep a placeholder row so the FK holds.
create or replace function public.architect_append_event(p_event jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into architect.runs (id, status, goal, data, created_at)
  values (p_event->>'runId', 'composing', '', jsonb_build_object('id', p_event->>'runId'), (p_event->>'at')::timestamptz)
  on conflict (id) do nothing;
  insert into architect.events (run_id, type, data, at)
  values (p_event->>'runId', p_event->>'type', coalesce(p_event->'data', '{}'::jsonb), (p_event->>'at')::timestamptz);
end $$;

create or replace function public.architect_events(p_run_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('runId', run_id, 'type', type, 'data', data, 'at', at) order by id), '[]'::jsonb)
  from architect.events where run_id = p_run_id;
$$;

-- Files travel as base64 text so they fit in JSON.
create or replace function public.architect_put_file(p_run_id text, p_path text, p_base64 text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into architect.runs (id, status, goal, data, created_at)
  values (p_run_id, 'composing', '', jsonb_build_object('id', p_run_id), now())
  on conflict (id) do nothing;
  insert into architect.files (run_id, path, content)
  values (p_run_id, p_path, decode(p_base64, 'base64'))
  on conflict (run_id, path) do update set content = excluded.content, updated_at = now();
end $$;

create or replace function public.architect_get_file(p_run_id text, p_path text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(content, 'base64') from architect.files where run_id = p_run_id and path = p_path;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'architect_save_run(jsonb)', 'architect_get_run(text)', 'architect_list_runs(int)',
    'architect_append_event(jsonb)', 'architect_events(text)',
    'architect_put_file(text, text, text)', 'architect_get_file(text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
