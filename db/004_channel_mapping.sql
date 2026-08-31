-- Booking.com identifies rooms and rates by its own codes, and those codes come
-- from the extranet rather than from anything we can derive. They are held on
-- our rows so the channel mapping is data, not a matching heuristic.

alter table room_types
  add column if not exists ota_room_type_code text;

alter table rate_plans
  add column if not exists ota_rate_plan_code text;

-- The channel connection itself, one per property per OTA.
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  channel text not null,                -- BookingCom, Airbnb, Expedia
  ota_hotel_id text,
  channex_channel_id uuid,
  is_active boolean not null default false,
  last_readiness jsonb,
  created_at timestamptz not null default now(),
  unique (property_id, channel)
);
