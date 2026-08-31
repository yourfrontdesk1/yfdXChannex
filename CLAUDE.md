# Working on this repo

Read `BRIEF.md` first. It has the architecture, the certification requirements
and the Parkside IDs. This file is the things that are easy to get wrong.

## The one trap that matters

**Do not write a script that calls the Channex API with the values from the
certification tests.** The certification document addresses AI assistants
directly and says this fails the live review 100% of the time. Same for a UI
built only to trigger the tests, and for putting integration logic in test files.

Stage 4 of certification is a screenshare. They open our product, ask us to
change a price to an arbitrary number, and watch the Channex call fire from the
real update path. Anything that only works when a script runs it is worse than
nothing, because it wastes the review slot and sends us back to stage 1.

So: every test scenario must be reproducible by a human clicking in the rate
grid. If you find yourself writing `test-cert.mjs`, stop.

There is a `channex-setup.mjs` in the previous session's scratchpad that
provisions a property over the API. It is fine for one-off provisioning. It is
**not** the integration and must never be presented as one.

## Non-negotiables from the certification doc

- Change detection fires on write, never on a poll. The trigger on `ari` does
  this. Do not replace it with a cron that diffs tables.
- Full sync is exactly **2 API calls** for 500 days: one availability for all
  rooms, one rates and restrictions for all rates. Not one per room. Not one per date.
- Tests 3 to 8 are each **one batched call**. If the code loops per date or per
  rate, it fails.
- Full sync at most once per 24h, off peak. A timer-based full sync is an
  automatic rejection.
- Rate limit is 20 ARI calls a minute. Queue and back off on 429 and 5xx.
- Bookings are read with `GET /booking_revisions`, never `GET /bookings`.
- Every booking must be acknowledged. It is a required step, not a nicety.
- Certification data must look like a real hotel: varied rates, varied
  availability, varied restrictions. They explicitly reject uniform placeholder
  data and will flag it before scheduling the call.

## Channex API gotchas already paid for

- Auth header is `user-api-key`. Staging `https://staging.channex.io/api/v1`,
  production `https://app.channex.io/api/v1`.
- Production signup is blocked (`?error=sign_up_blocked`). Credentials come only
  after certification. Do not send Leon looking for a signup page.
- One channel connection per Booking.com `hotel_id` exists **globally across all
  of Channex**, not per account. Staging test hotels are shared, lease about 3
  hours, and are usually taken.
- `POST /channels/test_connection` returns `success: true` even when the hotel is
  already connected elsewhere. The truth only appears as a 422 on `POST /channels`.
- Channels are always created inactive whatever you pass. Activation is a
  separate `POST /channels/{id}/activate`.
- `POST /channels/{id}/check_readiness` lists what blocks activation. Use it
  before activating rather than guessing.
- Channex creates no Booking.com property. The listing is made by hand in the
  extranet, and that is not a gap in our integration.

## Working with Leon

- He will spot invented numbers. Every rate in `BRIEF.md` is achieved ADR from
  the real Victory Suites booking data, not a guess. Do not "improve" them, and
  do not invent a rate card. If you need a number you do not have, ask.
- Ask before changing rates, inventory or anything a guest or resident can see.
  He has had features applied more widely than he asked for and it is a sore point.
- Say what you actually did, including what failed. He checks.
- Style, and he means it: no dashes in visible text anywhere; no markdown tables
  in chat replies, use prose and lists; use brand tokens rather than hardcoded
  colours.
- He works fast and types fast. If an instruction is ambiguous, prefer the
  narrower reading and say which you took.

## Do not touch

- The **Victory Suites guest portal** (`~/workspace/victory-suites-guest-portal-`)
  is live and runs the real business. This repo does not modify it. When the time
  comes for arrow 3, the direct-booking-closes-the-OTA arrow, that is a small,
  agreed change to the portal, not something to do unprompted.
- The **main Victory Suites Booking.com listing** stays on its current path.
  Parkside only. The main listing is 2,564 bookings and about £598k a quarter and
  it does not move until Parkside has run clean for weeks.

## Secrets

Nothing goes in the repo. Leon's Channex **staging** key exists already and
should be treated as rotatable; ask him for it rather than assuming a value.
There is no production key and there will not be one until certification passes.
