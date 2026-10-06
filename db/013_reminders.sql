-- When a guest who has not finished their check in was last reminded.
alter table inbound_bookings add column if not exists last_reminder_at timestamptz;
insert into hub_config (key, value) values ('reminders_enabled', 'true') on conflict (key) do nothing;
