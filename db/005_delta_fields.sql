-- Record WHICH field changed, not just that something did.
--
-- Channex rejected the first certification submission because a rate change
-- also carried min stay, stop sell and closed to arrival. The outbox only knew
-- the kind of change ('rate' or 'restriction'), so the payload builder had to
-- read the whole cell and send every field on it.
--
-- That one gap caused most of the failures: updates carrying fields they were
-- not supposed to, and consecutive dates refusing to merge into a date range
-- because the unrelated fields differed from day to day.

alter table outbox add column if not exists fields text[] not null default '{}';

create or replace function ari_enqueue() returns trigger as $$
declare
  changed text[] := '{}';
begin
  new.updated_at := now();

  -- Availability belongs to the room type and is its own call, so it is
  -- queued separately from anything on the rate plan.
  if tg_op = 'INSERT' then
    if new.availability is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'availability', new.room_type_id, null, new.date, array['availability']);
    end if;
  elsif new.availability is distinct from old.availability then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
    values (new.property_id, 'availability', new.room_type_id, null, new.date, array['availability']);
  end if;

  -- Rate and restrictions share the /restrictions endpoint but are queued as
  -- separate rows, so a rate change never drags a restriction along with it.
  if tg_op = 'INSERT' then
    if new.rate is not null then
      insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
      values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date, array['rate']);
    end if;
  elsif new.rate is distinct from old.rate then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
    values (new.property_id, 'rate', new.room_type_id, new.rate_plan_id, new.date, array['rate']);
  end if;

  if tg_op = 'INSERT' then
    if new.min_stay_through is not null then changed := array_append(changed, 'min_stay_through'); end if;
    if new.min_stay_arrival is not null then changed := array_append(changed, 'min_stay_arrival'); end if;
    if new.max_stay is not null then changed := array_append(changed, 'max_stay'); end if;
    if new.closed_to_arrival is not null then changed := array_append(changed, 'closed_to_arrival'); end if;
    if new.closed_to_departure is not null then changed := array_append(changed, 'closed_to_departure'); end if;
    if new.stop_sell is not null then changed := array_append(changed, 'stop_sell'); end if;
  else
    if new.min_stay_through is distinct from old.min_stay_through then changed := array_append(changed, 'min_stay_through'); end if;
    if new.min_stay_arrival is distinct from old.min_stay_arrival then changed := array_append(changed, 'min_stay_arrival'); end if;
    if new.max_stay is distinct from old.max_stay then changed := array_append(changed, 'max_stay'); end if;
    if new.closed_to_arrival is distinct from old.closed_to_arrival then changed := array_append(changed, 'closed_to_arrival'); end if;
    if new.closed_to_departure is distinct from old.closed_to_departure then changed := array_append(changed, 'closed_to_departure'); end if;
    if new.stop_sell is distinct from old.stop_sell then changed := array_append(changed, 'stop_sell'); end if;
  end if;

  -- Channex treat the two min stays as a pair and warn when they disagree, so
  -- a change to either sends both.
  if 'min_stay_through' = any(changed) and not ('min_stay_arrival' = any(changed)) then
    changed := array_append(changed, 'min_stay_arrival');
  elsif 'min_stay_arrival' = any(changed) and not ('min_stay_through' = any(changed)) then
    changed := array_append(changed, 'min_stay_through');
  end if;

  if array_length(changed, 1) > 0 then
    insert into outbox (property_id, kind, room_type_id, rate_plan_id, date, fields)
    values (new.property_id, 'restriction', new.room_type_id, new.rate_plan_id, new.date, changed);
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists ari_enqueue_trg on ari;
create trigger ari_enqueue_trg before insert or update on ari
for each row execute function ari_enqueue();
