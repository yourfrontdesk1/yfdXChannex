-- Opt-in gate for the new direct-forward flow (hub -> portal direct, then
-- booking.filed -> YourFrontDesk).
--
-- Default FALSE preserves today's behaviour exactly: every existing property
-- keeps forwarding through forwardToYourFrontDesk / forwardToGuestPortal, which
-- is the LIVE No Balcony path. Nothing changes for production until someone
-- opts a property in by setting this true. Flip it per property only after the
-- preview rehearsal passes for that property.

alter table properties
  add column if not exists use_direct_forward boolean not null default false;
