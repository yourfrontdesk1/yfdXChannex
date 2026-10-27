-- Durable per-room apartment assignment for the direct-forward flow.
--
-- Channex gives no stable per-room id: a room is only room_type_id + dates +
-- occupancy + amount, so two studios in one reservation are indistinguishable
-- by payload. The hub therefore derives a room_key once, at first sight, as
-- channex_room_type_id + "#" + ordinal, where the ordinal is the room's
-- position among rooms of the same type in the reservation (sorted by
-- checkin, checkout, then occupancy). The ordinal is NEVER recomputed on a
-- later revision; incoming rooms are mapped back onto the stored keys by best
-- fit, so a date change or a cancelled sibling cannot slide a guest onto
-- another key.
--
-- This table is the hub's durable (external_ref, room_key) -> apartment record:
-- "the first home we gave each room of a reference", reused on every modify so
-- a booking is never handed a fresh flat. The PORTAL remains the source of
-- truth for the CURRENT apartment (it alone sees direct, hand-made and staff
-- moves); this is only the hub's own memory.

create table if not exists room_assignments (
  external_ref text not null,
  room_key text not null,
  apartment text,
  revision_id text,
  created_at timestamptz not null default now(),
  primary key (external_ref, room_key)
);
