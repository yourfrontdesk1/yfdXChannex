-- Channel hub. One certified integration, many accounts, many properties.
--
-- An account here is a Channex "group": Victory Suites, Escape, or a
-- YourFrontDesk customer. Properties hang off an account, and every Channex
-- entity we create is recorded against ours so the mapping layer is explicit
-- rather than inferred.

create extension if not exists pgcrypto;

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  channex_group_id uuid,               -- the Channex group this account maps to
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  currency text not null default 'GBP',
  timezone text not null default 'Europe/Gibraltar',
  channex_property_id uuid,
  -- Where bookings for this property should be forwarded once received.
  downstream_url text,
  downstream_secret text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists room_types (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,
  count_of_rooms int not null default 1,
  occ_adults int not null default 2,
  occ_children int not null default 0,
  occ_infants int not null default 0,
  default_occupancy int not null default 2,
  channex_room_type_id uuid,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists rate_plans (
  id uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references room_types(id) on delete cascade,
  name text not null,
  occupancy int not null default 2,
  channex_rate_plan_id uuid,
  is_primary boolean not null default true,
  created_at timestamptz not null default now()
);

-- Availability is per room type per date. Rates and restrictions are per rate
-- plan per date. Kept in one table because every edit in the grid touches a
-- cell, and one row per cell is what makes a delta cheap to compute.
create table if not exists ari (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  rate_plan_id uuid references rate_plans(id) on delete cascade,
  date date not null,
  availability int,
  rate numeric(10,2),
  min_stay int,
  min_stay_arrival int,
  max_stay int,
  closed_to_arrival boolean,
  closed_to_departure boolean,
  stop_sell boolean,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (room_type_id, rate_plan_id, date)
);
create index if not exists ari_property_date_idx on ari(property_id, date);
create index if not exists ari_rate_plan_date_idx on ari(rate_plan_id, date);

-- The outbox. Every change to ari enqueues here; the worker batches these into
-- Channex calls. Channex reject anyone who full-syncs on a timer, so a delta
-- landing here is the only thing that ever causes a push.
create table if not exists outbox (
  id bigserial primary key,
  property_id uuid not null references properties(id) on delete cascade,
  kind text not null,                  -- availability | rate | restriction
  room_type_id uuid,
  rate_plan_id uuid,
  date date not null,
  enqueued_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text,
  channex_task_id uuid                 -- the task id Channex return, needed for certification
);
create index if not exists outbox_pending_idx on outbox(property_id, sent_at, enqueued_at);

-- Bookings arriving from Channex. Stored so an acknowledgement is never lost
-- and so a redelivery is idempotent on revision_id.
create table if not exists inbound_bookings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete set null,
  channex_booking_id text,
  revision_id text unique,
  ota_name text,
  ota_reservation_code text,
  status text,
  arrival_date date,
  departure_date date,
  guest_name text,
  amount numeric(10,2),
  currency text,
  payload jsonb not null,
  acknowledged_at timestamptz,
  forwarded_at timestamptz,
  forward_error text,
  received_at timestamptz not null default now()
);

-- Every Channex request and response, because certification asks for task IDs
-- and a screenshare reviewer will ask what fired and when.
create table if not exists channex_log (
  id bigserial primary key,
  property_id uuid,
  method text not null,
  path text not null,
  request jsonb,
  status int,
  response jsonb,
  task_id uuid,
  duration_ms int,
  at timestamptz not null default now()
);
create index if not exists channex_log_at_idx on channex_log(at desc);

-- Enqueue a delta whenever a cell changes. This is the change detection the
-- certification pre-flight asks for: it fires on write, not on a poll.
create or replace function ari_enqueue() returns trigger as $$
declare
  changed boolean;
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
    values (new.property_id, 'availability', new.room_type_id, null, new.date);

    if new.rate is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
      values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date);
    end if;

    if new.min_stay is not null
       or new.min_stay_arrival is not null
       or new.max_stay is not null
       or new.closed_to_arrival is not null
       or new.closed_to_departure is not null
       or new.stop_sell is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
      values (new.property_id, 'restriction', new.room_type_id, new.rate_plan_id, new.date);
    end if;

    return new;
  end if;

  if new.availability is distinct from old.availability then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
    values (new.property_id, 'availability', new.room_type_id, null, new.date);
  end if;

  if new.rate is distinct from old.rate then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
    values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date);
  end if;

  changed :=
       new.min_stay is distinct from old.min_stay
    or new.min_stay_arrival is distinct from old.min_stay_arrival
    or new.max_stay is distinct from old.max_stay
    or new.closed_to_arrival is distinct from old.closed_to_arrival
    or new.closed_to_departure is distinct from old.closed_to_departure
    or new.stop_sell is distinct from old.stop_sell;

  if changed then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date)
    values (new.property_id, 'restriction', new.room_type_id, new.rate_plan_id, new.date);
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists ari_enqueue_trg on ari;
create trigger ari_enqueue_trg before insert or update on ari
for each row execute function ari_enqueue();
