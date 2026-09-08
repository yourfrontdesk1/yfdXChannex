-- What a room type may be sold for, and where its price starts.
--
-- Every number here came from what these twelve apartments actually achieved,
-- not from a guess: the floor is the tenth percentile of cleaned achieved
-- nightly rate, the base is the median, and the ceiling sits above the best
-- night ever taken, because the point of pricing dynamically is to go where
-- flat pricing never did. They are rows rather than constants so a price fence
-- can move without a deploy.
create table if not exists pricing_rules (
  room_type_id uuid primary key references room_types(id) on delete cascade,
  floor_rate numeric(10,2) not null,
  base_rate numeric(10,2) not null,
  ceiling_rate numeric(10,2) not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (floor_rate > 0 and base_rate >= floor_rate and ceiling_rate >= base_rate)
);

-- Why a night is priced the way it is. Kept so a price can be explained to an
-- owner afterwards rather than defended from memory.
create table if not exists pricing_log (
  id bigserial primary key,
  property_id uuid not null references properties(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  date date not null,
  price numeric(10,2) not null,
  previous numeric(10,2),
  factors jsonb not null,
  at timestamptz not null default now()
);
create index if not exists pricing_log_date_idx on pricing_log(property_id, date, at desc);
