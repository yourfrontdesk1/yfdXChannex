# Channel Hub

A certified Channex integration. One codebase, many accounts, many properties.
Built so Channex certification happens once and every account after connects
through it.

## Why this exists

Channex will not give production credentials until the integration is certified,
and certification is of *software*, not of a listing. Stage 4 is a live
screenshare: they open your UI, ask you to change a price, and watch the API call
fire from the real code path. So the integration has to live in a real product
with a real rate grid, not in a script.

Certifying this repo rather than the Victory Suites portal means it is certified
once and is resellable. Accounts map to Channex groups, so Victory Suites,
Escape and every YourFrontDesk customer share one Channex organisation. That
matters commercially: the $130/month platform fee is paid once for the whole
organisation, and each property after is $7.

## The shape

Three pieces, and nothing else talks to an OTA.

- **This service** owns rates, availability and restrictions. Only it speaks to Channex.
- **Channex** is the pipe out to Booking.com, Airbnb, Expedia and the rest, and back.
- **Operational systems** (the VS guest portal today, YourFrontDesk for customers)
  keep doing check in, door codes, cleaning, invoices. They do not know Channex exists.

Four arrows:

1. Someone changes a price or closes a date here -> outbox -> Channex -> OTAs.
2. OTA booking -> Channex webhook -> here. Acknowledge, drop availability, push
   the new availability out, forward the booking downstream.
3. A direct booking downstream -> downstream calls us -> availability drops ->
   pushed to Channex so other channels close. This arrow does not exist today and
   is what prevents double bookings.
4. Cancellation is arrow 3 in reverse.

The service owns **availability**, not bookings. Bookings still live downstream.

## Certification requirements (from Channex)

https://docs.channex.io/api-v.1-documentation/pms-certification-tests

Before the tests, the integration must already have:

- change detection on ARI that fires on the event, not a polling loop
- an outbox/queue batching into calls, respecting 20 ARI calls/minute
- retry with backoff on 429 and 5xx
- a webhook endpoint receiving bookings, with acknowledgement
- a mapping layer between our IDs and Channex UUIDs

Hard rejections: a standalone script or Postman collection posting the test
values; a UI built only to trigger tests; full sync on a timer; per-date or
per-rate calls where the test says one call; integration logic living in test
files rather than the main path.

14 test scenarios. Full sync must be 500 days in exactly 2 calls (1 availability,
1 rates+restrictions). Tests 3 to 8 must each be a single batched call. Booking
receiving uses `GET /booking_revisions`, never `GET /bookings`. Full sync is
allowed at most once every 24h, off peak.

Form: https://forms.gle/xA8F3eSYBPBd8apYA

## Channex API facts

- Auth header: `user-api-key`
- Staging `https://staging.channex.io/api/v1`, production `https://app.channex.io/api/v1`
- Staging is free and self serve. **Production signup is blocked** (`?error=sign_up_blocked`);
  credentials are only issued after certification passes.
- Only ONE channel connection per Booking.com `hotel_id` exists globally across all
  of Channex, not per account. Staging test hotels are shared and lease for ~3 hours.
- `POST /channels/test_connection` returns `success: true` even when the hotel is
  already connected. The real check is the 422 on `POST /channels`.
- Channels are always created inactive. `POST /channels/{id}/activate` is separate.
- `POST /channels/{id}/check_readiness` lists what blocks activation.
- Channex creates no Booking.com property; the listing is made by hand in the extranet.
- API keys can be scoped to specific properties.

## First account: Victory Suites Parkside

A second Booking.com listing, deliberately separate from the main Victory Suites
one because bad reviews rather than price were dragging these units down. Not yet
open, which makes it the right pilot: nothing to lose if a push goes wrong.

- Booking.com Hotel ID: **17176790**
- Connectivity to Channex auto approved 31 Aug 2026 09:06. Scope includes rates
  and availability, reservations, guest messages, reviews, content.
- 12 apartments, 4 room types. Booking.com room type IDs:
  - `1717679004` Studio Apartment, 3 units, GBP 92, sleeps 2 (3.17A, 4.17A, 8.17A)
  - `1717679003` Executive Studio, 5 units, GBP 98, sleeps 3 (1.11, 2.05, 7.08, 7.18, 9.17B)
  - `1717679001` One-Bedroom Apartment, 3 units, GBP 99, sleeps 4 (1.14, 3.17B, 4.17B)
  - Confirmed 31 Aug 2026: 3.17B and 4.17B are one beds. The VS portal had them
    as executive studios and has been corrected.
  - `1717679002` Two-Bedroom Apartment, 1 unit, GBP 120, sleeps 5 (2.17)
- Rates above are the achieved ADR these same apartments made on the main listing
  over the 90 days to 31 Aug 2026, not guesses.
- The main Victory Suites listing (2,564 bookings, GBP 598k a quarter) does NOT move
  here until Parkside has run clean for weeks.

## Build order

1. Repo, Supabase, accounts/properties/room types/rate plans  <- schema done
2. ARI store, one row per room type + rate plan + date         <- schema done
3. Rate grid UI. Not optional: tests 2 to 8 are "change it in your UI while we watch"
4. Outbox on write (trigger done in schema)
5. Worker: batch, 20/min, backoff on 429 and 5xx, record the returned task_id
6. Booking webhook in, acknowledge, drop availability, forward downstream
7. Full sync, 500 days in 2 calls, on demand plus nightly off peak
8. Connect Parkside, run the 14 tests from the grid, submit form, screenshare

## State

**31 Aug 2026: certification form submitted.** Stage 3 of 5. All eleven test
scenarios passed, each as a single API call, against the dedicated test property
Channex require. Awaiting their review and the stage 4 screenshare.

Everything in the build order below is built and has run: schema, ARI store,
rate grid, outbox, worker, booking ingest with acknowledgement, full sync and
provisioning. See `CERTIFICATION.md` for the run log, task ids and the answers
submitted.
