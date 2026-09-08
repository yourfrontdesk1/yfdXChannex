-- Bookings made in the PMS itself, as opposed to inbound_bookings which arrive
-- from a channel. A PMS booking holds rooms exactly the way an inbound one
-- does: its effect on availability is recorded per revision so that moving or
-- cancelling it releases precisely what it took and nothing else.

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  guest_name text,
  checkin date not null,
  checkout date not null,
  rooms int not null default 1,
  status text not null default 'confirmed',   -- confirmed | cancelled
  applied_effect jsonb,                        -- "room_type_id|date" -> rooms held
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (checkout > checkin),
  check (rooms > 0)
);

create index if not exists bookings_property_idx on bookings(property_id, checkin desc);
