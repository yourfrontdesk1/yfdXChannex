-- Worker support. The outbox is drained by more than one invocation at a time,
-- so claiming has to be atomic, and the rate limiter counts real calls out of
-- the request log rather than trusting an in-memory counter that dies with the
-- process.

create index if not exists channex_log_prop_path_at_idx
  on channex_log(property_id, path, at desc);

create index if not exists outbox_claim_idx
  on outbox(property_id, sent_at, claimed_at, enqueued_at);

-- Claim a slice of a property's pending deltas. Skip locked means two workers
-- never fight over the same row, and a row claimed but not sent is released by
-- the reclaim window below rather than being lost.
create or replace function claim_outbox(p_property uuid, p_limit int default 5000)
returns setof outbox as $$
  update outbox o
     set claimed_at = now(),
         attempts = o.attempts + 1
   where o.id in (
     select id from outbox
      where property_id = p_property
        and sent_at is null
        and (claimed_at is null or claimed_at < now() - interval '5 minutes')
        and attempts < 8
      order by enqueued_at
      limit p_limit
      for update skip locked
   )
  returning o.*;
$$ language sql;

-- Properties with something waiting, so the worker never scans the whole table.
create or replace function properties_with_pending()
returns table (property_id uuid, pending bigint) as $$
  select property_id, count(*)
    from outbox
   where sent_at is null
     and attempts < 8
   group by property_id
   order by count(*) desc;
$$ language sql;
