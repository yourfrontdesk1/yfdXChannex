-- A modification has to undo whatever the previous revision of the same booking
-- did to availability before it applies its own, so the effect of each revision
-- is recorded rather than recomputed from a payload we would have to trust.

alter table inbound_bookings
  add column if not exists applied_at timestamptz,
  add column if not exists applied_effect jsonb;

create index if not exists inbound_bookings_booking_idx
  on inbound_bookings(channex_booking_id, received_at desc);

create index if not exists inbound_bookings_unacked_idx
  on inbound_bookings(acknowledged_at) where acknowledged_at is null;

-- Full sync is allowed once every 24 hours and off peak. Recording when it last
-- ran is what enforces that, rather than trusting a caller not to press twice.
alter table properties
  add column if not exists last_full_sync_at timestamptz;
