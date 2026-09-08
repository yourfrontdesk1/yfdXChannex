-- Switches a person can throw without a deploy, and a record of whether the
-- scheduled work actually ran.
--
-- Eight jobs now run unattended against a live business. Without this table the
-- way you learn one has stopped is a guest, which is not a way to learn it.
create table if not exists hub_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into hub_config (key, value) values
  ('auto_reply_enabled', 'true'),
  ('auto_link_enabled', 'true'),
  ('pricing_enabled', 'true')
on conflict (key) do nothing;

create table if not exists job_runs (
  id bigserial primary key,
  job text not null,
  ok boolean not null,
  detail jsonb,
  error text,
  ran_at timestamptz not null default now(),
  duration_ms int
);
create index if not exists job_runs_job_at_idx on job_runs(job, ran_at desc);

-- A thread that has been handed to a person, and why. The reply engine will not
-- touch one of these again.
create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  thread_id text not null,
  channex_booking_id text,
  reason text not null,
  message text,
  raised_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists escalations_open_idx on escalations(thread_id, resolved_at);
