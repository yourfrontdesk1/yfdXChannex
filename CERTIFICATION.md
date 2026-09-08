# Channex certification: run log

Staging. Property **Test Property - YourFrontDesk**, the dedicated test property
Channex ask for in their Setup Mapping section, not a real one.

- Channex property id `06474740-b4e1-4b04-8aea-9660ca7bc56d`
- Local id `54a82b02-6925-4e85-87a8-473e0bcc4598`
- Currency **USD**, two room types, four rate plans, exactly as specified

Everything below was performed through the product's own update path
(`POST /api/ari`, the route the rate grid posts to) and drained by the product's
own outbox worker. No script calls the Channex API directly.

## Ids for the mapping section of the form

| Field | Value |
|---|---|
| Property ID at Channex | `06474740-b4e1-4b04-8aea-9660ca7bc56d` |
| Twin Room ID | `8136fbb4-0bc8-41ae-99b5-a48260823a53` |
| Twin Room Best Available Rate ID | `6a4bc7f1-5302-4010-a6b6-092fc4d046f4` |
| Twin Room Bed & Breakfast Rate ID | `13d1eb76-48ee-442f-b125-0708d2c531b5` |
| Double Room ID | `b3a78981-1bd5-436f-9b42-13e5a7bb8a82` |
| Double Room Best Available Rate ID | `ddb282c0-b080-48ca-9349-ae300aade9d1` |
| Double Room Bed & Breakfast Rate ID | `0671abd2-4a99-436f-9137-376ba7e5f6a0` |

## Task ids

**Fourth run, 8 Sep 2026 08:49 to 08:52 UTC**, against the deployed service at
`channel-hub-phi.vercel.app`. Before the run every cell a scenario touches was
set, through the same grid route, to a value that is NOT the scenario value for
every field the scenario sets, so each field below is a genuine change and
appears in the request body. Each body was then read back out of `channex_log`
by task id and matched field for field against the scenario tables in the
Channex document: only the changed fields travel, ranges collapse to one value
object per rate plan, and both min stay fields go together.

The form wants the bare id only, not the response body. Every scenario went out
as **exactly one API call**, which is what the scenarios saying "this should be
1 API call" are testing.

| Test | Scenario | Endpoint | Values | Task id |
|---|---|---|---|---|
| 1 | Full sync, 500 days | `/availability` | 747 | `c8f12d90-2147-48f5-9561-f1aad844f4f3` |
| 1 | Full sync, 500 days | `/restrictions` | 1925 | `ae8d548a-29ff-4b27-880d-f146893287d0` |
| 2 | Single date, single rate | `/restrictions` | 1 | `0cfb075a-14f9-44f8-bddd-1a0e4f8f8fa9` |
| 3 | Single date, multiple rates | `/restrictions` | 3 | `03076875-cc9f-4093-972d-032ee21e1c06` |
| 4 | Multiple dates, multiple rates | `/restrictions` | 3 | `b48785d0-eeee-4975-8786-9edb1254e469` |
| 5 | Min stay | `/restrictions` | 3 | `d299f5a9-a49b-4854-90c7-33b0038b03aa` |
| 6 | Stop sell | `/restrictions` | 3 | `55d6e826-08d7-4f7e-a20e-d4b977aa9251` |
| 7 | Multiple restrictions | `/restrictions` | 4 | `1c35ebc2-dc9d-4493-b946-09c59db001de` |
| 8 | Half year, Dec 2026 to May 2027 | `/restrictions` | 2 | `70d83688-83f3-4244-b0a8-2b4c1a93b88f` |
| 9 | Single date availability | `/availability` | 2 | `16d7d8e1-33ce-41ab-b169-13de3935b4d3` |
| 10 | Multiple date availability | `/availability` | 2 | `0ae90515-a205-49c6-8fec-96e6ca41dd8e` |
| 11 | Booking receive, modify, cancel | feed + ack | 3 revisions | passed twice, ids below |

### Test 11 ids

Fourth run, 8 Sep 2026, on Channex test hotel `10485037` (USD, matching the
property). Booking.com confirmation `6509905415`, guest "Certification Test",
Studio, made through the public Booking.com test checkout, then changed to
24 to 26 Nov through "Change dates", then cancelled through "Cancel booking".

| Field | Value |
|---|---|
| Booking ID | `eccd4a80-4a43-464e-8a98-6e3ca5bf7e51` |
| New Revision | `556f69aa-70a2-4177-afe3-8929fb158d4c` |
| Modified Revision | `ce2baa7e-e03d-4be3-b445-a2dba4883785` |
| Cancelled Revision | `a707b025-4e25-43fb-ba8f-9533987f9d4e` |

All three revisions arrived on the same booking, the first through the webhook
and the feed, the others through the feed, each acknowledged back with
`POST /{id}/ack` within a second of arrival, and applied in order. Availability
followed the booking absolutely, not by delta: Twin 21 Nov went 7 to 6 on the
new revision (task `016c5424-6de4-4398-9d6f-5ba5534ff921`), the modification
released 21 Nov and took 24 and 25 Nov in one call of three values (task
`45ed21de-cdfb-4c92-b422-1ff29872253e`), and the cancellation released both in
one call of two values (task `0bb5df9d-49bb-45fc-b14b-256cb91acbb5`).

Worth telling the reviewer: a first attempt to move the booking to 21 to 23 Nov
was refused by Booking.com because 22 Nov is sold out with stop sell on our
side, which is the integration doing its job.

The 31 Aug run on test hotel `10484818` had booking
`b8ae39e9-e396-4935-b0e2-a5072971a71e` with revisions
`ac4e35e0-11f2-4a7f-aefb-ae51a5d61506`, `81cb9d89-e876-405a-9e34-ffc5cbba85eb`
and `faf4a553-deac-4ea4-8505-db71a53c64a4`; Channex have since deleted that
channel.

Test 8 is the one worth pointing at in review: 304 edited cells across five
months collapsed into a single call carrying 2 ranged values, one per rate plan,
Twin Room Best Available Rate sending rate, min stay and both closures, Double
Room Best Available Rate sending only rate and min stay.

## Data state

Deliberately not uniform, since Channex reject placeholder-looking data before
they will schedule the call. Base rates are their specified 100 and 120, with an
ordinary seasonal and weekday shape laid over 500 days, plus sold out nights,
minimum stays and arrival closures.

Shape is generated in `scripts/seed-cert-property.mjs`, seeded off the date so a
re-seed reproduces the same numbers a submitted task id was taken against.

## Channel

Connected and **active** on Channex test hotel `10485037` (USD), channel
`7e4ccdb3-c689-4597-9a89-811cdb1fda03`, 4 mappings (Twin to Studio
`1048503703`, Double to Apartment `1048503702`, Best Available to Standard Rate
`37364460`, Bed & Breakfast to Non-Refundable `37364467`), readiness clean.
Booking webhook `01137a85-8b38-4cbb-a619-14f2ca7840a9` points at
`/api/webhooks/channex` on channel-hub-phi.vercel.app with the shared secret in
a header; the feed poll at `/api/bookings/poll` is the recovery path.

The shared test hotels are leased and reclaimed. On 8 Sep every one of them was
taken for the first hour; a retry every ten minutes got `10485037` at 09:00 UTC.
The hotel's room and rate codes come from `POST /channels/mapping_details` with
the hotel id, and are stored on our room types and rate plans before
`/api/provision?action=connect` will map anything.

**The real Parkside listing `17176790` has deliberately not been connected.**
Only one channel per Booking.com hotel id exists across the whole of Channex, so
binding it in staging risks getting in the way at go-live.

## What is left

All eleven scenarios are complete. **Form resubmitted 8 Sep 2026** with the
fourth run's ids, contact leon@victorygate.gi, all eight restrictions declared,
no card data, not PCI. Remaining:

1. Their review, then the stage 4 screenshare

Note for the call: the channel now carries full rate plan mappings, and the
8 Sep booking decremented and released the right room type on every revision,
so the earlier null `room_type_id` caveat no longer applies.

At the screenshare they will ask for arbitrary changes made by hand in the rate
grid. Everything above is reproducible that way; nothing here depends on the
harness that collected the ids.

---

# Stage 4: live test by video (Channex email, 8 Sep 2026)

Channex passed all eleven scenarios and asked for a short screen recording,
no call needed, showing both the action in the PMS and the update arriving in
the Channex staging app (property Messages or Logs screen). Upload it anywhere
"anyone with the link" can open, and email the link plus the staging property
id `06474740-b4e1-4b04-8aea-9660ca7bc56d` to evan@channex.io. They answer
within two business days.

Built for it on 8 Sep: a Bookings panel on the YourFrontDesk Channels page
(`/channels`), backed by `POST /api/bookings` on the hub, table `bookings`.
A booking holds its nights through the same effect logic inbound bookings use
(`src/lib/holds.ts`), so only the touched dates are written and sent.

Rehearsed through the route on 8 Sep, test property, Twin Room:

| Step | What went to Channex | Task id |
|---|---|---|
| Add booking 2 to 3 Dec | one `/availability` call, 1 value, 2 Dec only | `30358022-2737-40e6-80fe-478d163821cd` |
| Move a week later, 9 to 10 Dec | one `/availability` call, 2 values, 2 Dec released and 9 Dec taken | `421f14f7-6412-442f-9ef8-9289bdd5dbcc` |
| Full sync | 2 calls, 751 availability and 1666 rate values | `360245fd-f38a-41b7-bec6-ae2f85ca28f7`, `6d2bf8d5-97f2-40cc-8dd9-1b7f1b5d9f52` |
| Cancel | one `/availability` call, 1 value, 9 Dec released | `54954004-eee2-4cff-9b74-0c55437f70b3` |

## Recording script

Two windows side by side: YourFrontDesk `/channels` on the left with the
**Test Property - YourFrontDesk** chosen, the Channex staging app on the right
open on that property's Logs (or Messages) screen. Keep both visible the whole
time. Speak or caption each step.

1. Point at the grid: Twin Room "Rooms free" for the date you are about to
   book. Say the number.
2. Bookings panel: Room type Twin Room, check-in a date a month or two out,
   check-out the next day, a guest name, **Add booking**. The toast names the
   date and the task id. The grid cell drops by one. In Channex, refresh Logs:
   one availability update, that one date, nothing else.
3. **Move a week later** on that booking. Toast: two dates, one call. Grid: the
   old date goes back up, the new date drops. Channex Logs: one availability
   update carrying both dates.
4. **Full sync** button top right. Toast: "two calls". Channex Logs: one
   availability task and one restrictions task, nothing more.
5. Optional but they asked for it before any call: **Cancel** the booking. One
   availability update, the new date released.

Choose dates that are open on our side; the grid shows it. A sold out or stop
sell night would be refused, correctly, but it makes a confusing video.

## Email to send with the link

To: evan@channex.io
Subject: YourFrontDesk certification, live test video

Hi Evan,

Thank you for the pass on the certification scenarios. The live test video is
here: <link>

Staging property: Test Property - YourFrontDesk, 06474740-b4e1-4b04-8aea-9660ca7bc56d

The recording shows, in YourFrontDesk and in the Channex staging logs: a one
night booking created in the PMS (one availability update, that date only), the
same booking moved a week later (one update carrying the original and the new
date), and a full sync from the button in the PMS (two calls). It ends with the
booking cancelled and the night released.

Kind regards,
Leon Thick
YourFrontDesk

---

# Form answers, ready to paste

## 12. Can you stay in rate limits?

Yes.

The limiter counts real calls out of the `channex_log` table per property
rather than an in-memory counter, because the worker runs serverless and a cold
process forgets what it sent while the limit does not. Budget is 10 calls a
minute each to `/availability` and `/restrictions`, and `remainingAriBudget()`
is consulted before a batch goes out rather than after a rejection.

429 and 5xx are treated as transient and retried with backoff at 2s, 6s and
15s. A row that keeps failing stops at 8 attempts and is left for the reclaim
window instead of spinning. Claiming uses `for update skip locked`, so two
workers never send the same delta twice.

One detail worth flagging: a 200 carrying warnings and an empty data array is
treated as a **failure**, not a success. Anything writing ARI has to, or a
silent rejection looks like a delivery.

## 13. Do you agree to only send updated changes?

Yes, agreed, and it is how the system already works.

A Postgres trigger on the `ari` table enqueues a delta to an outbox on write.
Nothing polls and nothing diffs tables on a schedule. If a cell does not change,
no row is enqueued and no call is made.

Full sync is not on a timer. It is on demand, guarded by a 24 hour minimum
between runs per property, and it marks any pending outbox rows as superseded so
the same state is never sent twice. It goes out as exactly two calls for 500
days, one availability and one rates and restrictions.

## 14. Extra notes

**Do you support both Min Stay Through and Arrival?**
Both. Held separately as `min_stay_through` and `min_stay_arrival` and editable
independently in the rate grid.

**Any restrictions you do not support?**
None. Stop Sell, Closed to Arrival, Closed to Departure, Max Stay, Min Stay
Through and Min Stay Arrival are all supported, alongside rate and availability.

**Do you support multiple room types and multiple rate plans per room type?**
Yes. The certification property carries four room types with two rate plans each,
Best Available Rate and Non-Refundable.

**Do you need credit card details with bookings?**
No. The integration neither requests nor stores card data. Payment is handled
away from this service.

**Are you PCI certified, or do you use a PCI service?**
Neither, and it is not in scope. No card data is received, stored or passed on
by this integration.

## Scenarios skipped

None. All scenarios were performed against the dedicated test property.

## Production cutover, 8 September 2026

The hub runs on the live Channex account. `CHANNEX_ENV=production` and a
production `CHANNEX_API_KEY` are set on Vercel (`channel-hub`, Production) and in
`.env.local`, so local and deployed both talk to `app.channex.io`. The staging key
is kept in the scratchpad backup only.

Every staging id was cleared before the switch, because the hub holds one
`CHANNEX_ENV` for all properties and a staging id pushed at a live channel is the
one mistake that cannot be undone quietly. Cleared: both accounts'
`channex_group_id`, both properties' `channex_property_id`, 6 room types, 12 rate
plans, and both `channels` rows (also set inactive). The certification test
property is `is_active=false` and lost its Booking.com room codes with it. The
outbox was empty, so nothing stale could drain into production.

Parkside was then rebuilt on production by `POST /api/provision`:

- group `23b94e08-458b-41ea-86de-5a9e21433f78` (Victory Suites)
- property `70372215-ecee-4c4e-801b-fc493c4c7897`
- 4 room types, 8 rate plans, all created clean

`POST /api/full-sync?force=1` then pushed 500 days as **two calls**, the same
shape certification passed on: availability task
`ab1fd5d8-3e4f-47c5-9526-67aaec891742` with 615 values, restrictions task
`9192c7e5-98a1-4f9b-94d8-0ac42acc2f82` with 3484 values, both `success: true`
with no errors.

Booking webhook `209a5e3a-b19f-464e-b44e-2f79afec43e0` is registered on
production against the Parkside property, pointed at
`/api/webhooks/channex` on channel-hub-phi.vercel.app, `send_data` true, secret
in the `x-channex-webhook-secret` header, mask
`booking_new;booking_modification;booking_cancellation` (semicolons, a comma is
rejected). The 15 minute `/api/bookings/poll` cron stays as the recovery path.

**Still open, and deliberately so.** No channel exists on the production account
yet. The real Parkside listing, Booking.com hotel `17176790`, is still driven by
Little Hotelier. Channex allows one connection per hotel id across their entire
platform, so it has to come off Little Hotelier in the extranet first, and only
then does `/api/provision?action=connect&hotel_id=17176790` have anything to bind
to. Room codes 1717679001 to 1717679004 are already stored on the Parkside room
types and survived the cutover, so the connect call has what it needs. That step
is Leon's to trigger. The main Victory Suites listing does not move.
