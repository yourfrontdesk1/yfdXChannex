-- Guest messages and reviews arriving from the OTA through Channex.
--
-- Stored the moment they arrive, before anything clever happens to them, so a
-- guest question is never lost to a bug further down the line. Replying is a
-- separate job; this is the record.
create table if not exists guest_messages (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete set null,
  channex_message_id text unique,
  thread_id text,
  channex_booking_id text,
  ota_reservation_code text,
  direction text not null default 'inbound',
  sender text,
  body text,
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  forwarded_at timestamptz,
  raw jsonb
);
create index if not exists guest_messages_thread_idx on guest_messages(thread_id, received_at desc);
create index if not exists guest_messages_pending_idx on guest_messages(forwarded_at, received_at);

create table if not exists guest_reviews (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete set null,
  channex_review_id text unique,
  channex_booking_id text,
  guest_name text,
  rating numeric(4,2),
  body text,
  received_at timestamptz not null default now(),
  responded_at timestamptz,
  raw jsonb
);
create index if not exists guest_reviews_received_idx on guest_reviews(received_at desc);
