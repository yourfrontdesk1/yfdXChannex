-- Which apartments sell as each room type, held where a new listing can be added
-- without a deploy. Until 6 October this lived in code (ROOMS_BY_TYPE), which
-- meant every new Booking.com listing needed a code change before it could sell.
alter table room_types add column if not exists apartments text[] not null default '{}';

update room_types set apartments = array['3.17A','4.17A','8.17A'] where id = '930fa1c5-7c94-4c45-bc58-e3eb3fad103b';
update room_types set apartments = array['1.11','2.05','7.08','7.18','9.17B'] where id = '4e0d43ef-a1ad-4e1d-acc6-607a4ecb69f3';
update room_types set apartments = array['1.14','3.17B','4.17B'] where id = '8154bc8f-1152-49ae-88b8-cadd9ad01d04';
update room_types set apartments = array['2.17'] where id = '288806ec-b0c0-4050-8caf-94eee431194a';
update room_types set apartments = array['1.02','6.02'] where id = '374c2b56-b6ad-40aa-b23f-24372131d3b0';

-- No apartment may sell under two room types at once, or both would count it
-- free and the same night would go twice.
create or replace function room_types_apartments_unique() returns trigger as $$
declare clash text;
begin
  select a into clash
  from room_types rt, unnest(rt.apartments) a
  where rt.id <> new.id and a = any(new.apartments)
  limit 1;
  if clash is not null then
    raise exception 'Apartment % already sells under another room type', clash;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists room_types_apartments_unique_trg on room_types;
create trigger room_types_apartments_unique_trg before insert or update of apartments on room_types
  for each row execute function room_types_apartments_unique();
