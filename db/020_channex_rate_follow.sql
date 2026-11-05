-- Follow prices changed directly on Channex (Leon, 5 Nov 2026).
-- See src/lib/channexRateFollow.ts. Nothing here changes a normal write to ari:
-- ari_enqueue only skips when absorb_channex_rates has set hub.skip_outbox for
-- its own transaction.

create table if not exists channex_rates_dirty (
  property_id uuid primary key references properties(id) on delete cascade,
  from_date date not null,
  to_date date not null,
  first_event_at timestamptz not null default now(),
  last_event_at timestamptz not null default now(),
  last_user_id text
);

create table if not exists channex_price_changes (
  id bigserial primary key,
  detected_at timestamptz not null default now(),
  property_id uuid not null references properties(id) on delete cascade,
  room_type_id uuid not null,
  rate_plan_id uuid not null,
  room_type_name text,
  rate_plan_name text,
  date date not null,
  old_rate numeric,
  new_rate numeric not null,
  channex_user_id text,
  applied boolean not null
);
create index if not exists channex_price_changes_detected_idx on channex_price_changes(detected_at desc);
alter table channex_rates_dirty enable row level security;
alter table channex_price_changes enable row level security;

CREATE OR REPLACE FUNCTION public.ari_enqueue()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  changed text[] := '{}';
begin
  -- A price copied FROM Channex must never be queued back TO Channex.
  if current_setting('hub.skip_outbox', true) = 'on' then return null; end if;

  if tg_op = 'INSERT' then
    if new.availability is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'availability', new.room_type_id, null, new.date, array['availability']);
    end if;
    if new.rate is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date, array['rate']);
    end if;
    if new.min_stay_through is not null then changed := array_append(changed, 'min_stay_through'); end if;
    if new.min_stay_arrival is not null then changed := array_append(changed, 'min_stay_arrival'); end if;
    if new.max_stay is not null then changed := array_append(changed, 'max_stay'); end if;
    if new.closed_to_arrival is not null then changed := array_append(changed, 'closed_to_arrival'); end if;
    if new.closed_to_departure is not null then changed := array_append(changed, 'closed_to_departure'); end if;
    if new.stop_sell is not null then changed := array_append(changed, 'stop_sell'); end if;
  else
    if new.availability is distinct from old.availability then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'availability', new.room_type_id, null, new.date, array['availability']);
    end if;
    if new.rate is distinct from old.rate then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date, array['rate']);
    end if;
    if new.min_stay_through is distinct from old.min_stay_through then changed := array_append(changed, 'min_stay_through'); end if;
    if new.min_stay_arrival is distinct from old.min_stay_arrival then changed := array_append(changed, 'min_stay_arrival'); end if;
    if new.max_stay is distinct from old.max_stay then changed := array_append(changed, 'max_stay'); end if;
    if new.closed_to_arrival is distinct from old.closed_to_arrival then changed := array_append(changed, 'closed_to_arrival'); end if;
    if new.closed_to_departure is distinct from old.closed_to_departure then changed := array_append(changed, 'closed_to_departure'); end if;
    if new.stop_sell is distinct from old.stop_sell then changed := array_append(changed, 'stop_sell'); end if;
  end if;

  -- Channex treat the two min stays as a pair and warn when they disagree.
  if 'min_stay_through' = any(changed) and not ('min_stay_arrival' = any(changed)) then
    changed := array_append(changed, 'min_stay_arrival');
  elsif 'min_stay_arrival' = any(changed) and not ('min_stay_through' = any(changed)) then
    changed := array_append(changed, 'min_stay_through');
  end if;

  if array_length(changed, 1) > 0 then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
    values (new.property_id, 'restriction', new.room_type_id, new.rate_plan_id, new.date, changed);
  end if;

  return null;
end $function$;

create or replace function mark_channex_rates_dirty(p_property uuid, p_from date, p_to date, p_user text)
returns void language sql as $$
  insert into channex_rates_dirty (property_id, from_date, to_date, last_user_id)
  values (p_property, p_from, p_to, p_user)
  on conflict (property_id) do update set
    from_date = least(channex_rates_dirty.from_date, excluded.from_date),
    to_date = greatest(channex_rates_dirty.to_date, excluded.to_date),
    last_event_at = now(),
    last_user_id = coalesce(excluded.last_user_id, channex_rates_dirty.last_user_id);
$$;

-- Copies prices into ari with the outbox trigger off, and logs them. A row is only
-- written if ari still holds the price it was compared with, so a YourFrontDesk
-- price that landed in between wins. p_apply false logs without writing.
create or replace function absorb_channex_rates(p_property uuid, p_rows jsonb, p_user text, p_apply boolean)
returns integer language plpgsql as $$
declare n integer := 0;
begin
  perform set_config('hub.skip_outbox', 'on', true);
  create temp table _absorb on commit drop as
    select * from jsonb_to_recordset(p_rows) as x(
      room_type_id uuid, rate_plan_id uuid, date date, old_rate numeric, new_rate numeric,
      room_type_name text, rate_plan_name text);
  if p_apply then
    create temp table _done on commit drop as
    with up as (
      update ari a set rate = i.new_rate from _absorb i
       where a.property_id = p_property and a.room_type_id = i.room_type_id
         and a.rate_plan_id = i.rate_plan_id and a.date = i.date
         and a.rate is not distinct from i.old_rate
      returning a.rate_plan_id, a.date
    ), ins as (
      insert into ari (property_id, room_type_id, rate_plan_id, date, rate)
      select p_property, i.room_type_id, i.rate_plan_id, i.date, i.new_rate from _absorb i
       where not exists (select 1 from ari a where a.room_type_id = i.room_type_id and a.rate_plan_id = i.rate_plan_id and a.date = i.date)
      on conflict do nothing
      returning rate_plan_id, date
    )
    select * from up union all select * from ins;
    insert into channex_price_changes (property_id, room_type_id, rate_plan_id, room_type_name, rate_plan_name, date, old_rate, new_rate, channex_user_id, applied)
    select p_property, i.room_type_id, i.rate_plan_id, i.room_type_name, i.rate_plan_name, i.date, i.old_rate, i.new_rate, p_user, true
      from _absorb i join _done d on d.rate_plan_id = i.rate_plan_id and d.date = i.date;
    get diagnostics n = row_count;
  else
    insert into channex_price_changes (property_id, room_type_id, rate_plan_id, room_type_name, rate_plan_name, date, old_rate, new_rate, channex_user_id, applied)
    select p_property, i.room_type_id, i.rate_plan_id, i.room_type_name, i.rate_plan_name, i.date, i.old_rate, i.new_rate, p_user, false
      from _absorb i;
  end if;
  perform set_config('hub.skip_outbox', 'off', true);
  return n;
end $$;
