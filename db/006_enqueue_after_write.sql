-- Enqueue after the write, not before it.
--
-- The grid saves with an upsert. On a BEFORE trigger Postgres runs the INSERT
-- branch first, then the UPDATE branch once it detects the conflict, so every
-- save enqueued twice. Worse, the INSERT branch treats every non-null field as
-- new, so a rate-only edit also queued min stay, closed to arrival and stop
-- sell for a row that already had them.
--
-- That is what Channex saw as "update should contain only rates, but also
-- contains restriction(s)", and why seven consecutive days of one rate change
-- would not merge into a single date range.
--
-- Splitting it fixes both: BEFORE only stamps updated_at, which it has to do to
-- modify the row, and AFTER enqueues exactly once, for the operation that
-- actually happened.

create or replace function ari_touch() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end $$ language plpgsql;

create or replace function ari_enqueue() returns trigger as $$
declare
  changed text[] := '{}';
begin
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
end $$ language plpgsql;

drop trigger if exists ari_enqueue_trg on ari;
drop trigger if exists ari_touch_trg on ari;

create trigger ari_touch_trg before insert or update on ari
for each row execute function ari_touch();

create trigger ari_enqueue_trg after insert or update on ari
for each row execute function ari_enqueue();
