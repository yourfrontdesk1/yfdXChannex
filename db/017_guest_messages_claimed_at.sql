-- reply.ts claims each inbound guest message with update({ claimed_at }) so two
-- workers never answer the same message. No migration ever created that column:
-- production has it out of band, but a fresh database (the staging rehearsal)
-- did not, which silently makes every claim fail and Charlotte never answer.
-- Idempotent, so safe to apply everywhere.
alter table guest_messages add column if not exists claimed_at timestamptz;
create index if not exists guest_messages_unclaimed_idx
  on guest_messages(claimed_at) where claimed_at is null;
