-- The answer cron picks the oldest unanswered guest messages and, until now, a
-- message it could not answer stayed forwarded_at null forever: a booking it
-- never matched, or a thread rate limited, sat among the oldest ten and was
-- re-picked on every single run, burning a claim each time and crowding out
-- newer messages behind it.
--
-- skipped_reason/skipped_at record that a message was set aside and why:
--   - a permanent skip (no booking, nothing to answer from) also sets
--     forwarded_at, so it leaves the queue for good but the reason stays for the
--     health alert count.
--   - a soft skip (rate limited, or a technical failure) leaves forwarded_at
--     null and is re-picked after a short cooldown, so a transient failure is
--     still retried rather than dropped.
--
-- Idempotent, so safe to apply everywhere.
alter table guest_messages add column if not exists skipped_reason text;
alter table guest_messages add column if not exists skipped_at timestamptz;

-- The answer query filters on (forwarded_at is null) and the skip cooldown, so a
-- partial index on the rows still in play keeps the pick cheap.
create index if not exists guest_messages_skipped_idx
  on guest_messages(skipped_at) where skipped_at is not null;
