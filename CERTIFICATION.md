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

The form wants the bare id only, not the response body. Every scenario went out
as **exactly one API call**, which is what the scenarios saying "this should be
1 API call" are testing.

| Test | Scenario | Endpoint | Values | Task id |
|---|---|---|---|---|
| 1 | Full sync, 500 days | `/availability` | 259 | `216dabe2-53d3-4ac1-af76-bbb885f3136d` |
| 1 | Full sync, 500 days | `/restrictions` | 634 | `929daf64-90b5-4193-a63d-a5cf7e8b4539` |
| 2 | Single date, single rate | `/restrictions` | 1 | `ccfdc683-6b24-45b8-8764-11c3377a63c8` |
| 3 | Single date, multiple rates | `/restrictions` | 3 | `cc2f9ff5-0ae9-43aa-8338-a2d92fee6248` |
| 4 | Multiple dates, multiple rates | `/restrictions` | 16 | `85b826b7-ccef-4990-bd90-f8fa63913bd5` |
| 5 | Min stay | `/restrictions` | 3 | `e6fcddc4-bfbd-4553-b359-689ab97cc0bd` |
| 6 | Stop sell | `/restrictions` | 3 | `5a2e1478-2875-452d-baa7-c67340c4a771` |
| 7 | Multiple restrictions | `/restrictions` | 21 | `807bb083-3936-47f5-810b-c33a20590c88` |
| 8 | Half year, Dec 2026 to May 2027 | `/restrictions` | 49 | `8350ef76-d991-4fab-83e8-90cf36420a33` |
| 9 | Single date availability | `/availability` | 4 | `5f3618eb-6b6b-4dcb-8471-bac2225f1c1f` |
| 10 | Multiple date availability | `/availability` | 14 | `4d46b3dc-0294-42cc-91aa-6d01bb3a41d2` |
| 11 | Booking receive, modify, cancel | feed + ack | 3 revisions | see below |

### Test 11 ids

| Field | Value |
|---|---|
| Booking ID | `b8ae39e9-e396-4935-b0e2-a5072971a71e` |
| New Revision | `ac4e35e0-11f2-4a7f-aefb-ae51a5d61506` |
| Modified Revision | `81cb9d89-e876-405a-9e34-ffc5cbba85eb` |
| Cancelled Revision | `faf4a553-deac-4ea4-8505-db71a53c64a4` |

All three revisions arrived on the same booking, were pulled from
`/booking_revisions/feed`, acknowledged back with `POST /{id}/ack`, and applied
in order. The modification updated the existing record rather than creating a
second one, matching on revision.

Test 8 is the one worth pointing at in review: 304 edited cells across five
months collapsed into a single call carrying 49 ranged values.

## Data state

Deliberately not uniform, since Channex reject placeholder-looking data before
they will schedule the call. Base rates are their specified 100 and 120, with an
ordinary seasonal and weekday shape laid over 500 days, plus sold out nights,
minimum stays and arrival closures.

Shape is generated in `scripts/seed-cert-property.mjs`, seeded off the date so a
re-seed reproduces the same numbers a submitted task id was taken against.

## Channel

Connected and **active** on Channex test hotel `10484818`, channel
`243193cb-60c7-4d3b-b750-62918de01cea`, 4 mappings, readiness clean.

**The real Parkside listing `17176790` has deliberately not been connected.**
Only one channel per Booking.com hotel id exists across the whole of Channex, so
binding it in staging risks getting in the way at go-live.

## What is left

All eleven scenarios are complete. Remaining:

1. Submit https://forms.gle/xA8F3eSYBPBd8apYA
2. Their review, then the stage 4 screenshare

Note for the call: the channel on the shared test hotel carries rooms but no
rate plan mappings, which is why inbound bookings arrived with a null
`room_type_id` and did not decrement a specific room type. That is a mapping gap
on their shared sandbox, not a code path: availability writes are demonstrated
by tests 9 and 10, both of which pushed cleanly. Map rate plans in the Channex
dashboard before relying on inbound availability decrements.

At the screenshare they will ask for arbitrary changes made by hand in the rate
grid. Everything above is reproducible that way; nothing here depends on the
harness that collected the ids.

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
