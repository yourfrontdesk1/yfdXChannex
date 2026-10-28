-- Who owns a property's nightly pricing. Default true: the hub's own pricing
-- engine computes and pushes rates. Set false when YourFrontDesk owns pricing
-- and sends rates through POST /api/rates; then priceAll skips the property so
-- the engine never overwrites YFD's numbers, while availability still syncs.
-- Idempotent.
alter table properties add column if not exists managed_pricing boolean not null default true;
