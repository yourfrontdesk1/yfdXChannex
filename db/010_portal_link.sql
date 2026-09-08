-- What the guest portal gave back when a booking was handed over: the guest's
-- own link, and the payment link the AI has to send them. Kept here so the hub
-- can message a guest without asking the portal twice.
alter table inbound_bookings add column if not exists portal_token text;
alter table inbound_bookings add column if not exists portal_url text;
alter table inbound_bookings add column if not exists payment_link text;
alter table inbound_bookings add column if not exists link_sent_at timestamptz;
