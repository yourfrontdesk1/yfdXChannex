-- Connect-day "Pull Future Reservations" window. forwardDirect stamps a booking
-- booking.filed with pulled:true ONLY while now < pull_window_until. It is set
-- right before the pull is triggered and cleared straight after, so a live new
-- or modified reservation is never mis-stamped as pulled. Null means no window
-- open (the normal state), so live forwarding is unaffected. Idempotent.
alter table properties add column if not exists pull_window_until timestamptz;
