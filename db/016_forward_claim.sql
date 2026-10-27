-- A per-revision forward claim, so the webhook, the 15-minute poll and the
-- retry cron cannot all forward the SAME revision at once. Two simultaneous
-- first-time POSTs for the same new room_key can orphan a guest row, so the
-- direct-forward path claims the revision with a conditional UPDATE before
-- doing any work:
--
--   update inbound_bookings set forward_claimed_at = now()
--   where revision_id = ?
--     and (forward_claimed_at is null or forward_claimed_at < now() - interval '5 minutes')
--
-- Whoever the UPDATE affects holds the claim; everyone else gets no row back and
-- returns quietly. The 5-minute window lets a crashed forward be re-claimed.

alter table inbound_bookings
  add column if not exists forward_claimed_at timestamptz;
