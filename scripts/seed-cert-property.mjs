#!/usr/bin/env node
/**
 * Seeds the property Channex ask for in the certification setup: a dedicated
 * test property, not a real one.
 *
 *   Test Property - YourFrontDesk, USD
 *   Twin Room   (2 occupancy)  Best Available Rate 100, Bed & Breakfast Rate 120
 *   Double Room (2 occupancy)  Best Available Rate 100, Bed & Breakfast Rate 120
 *
 *   node scripts/seed-cert-property.mjs            structure only
 *   node scripts/seed-cert-property.mjs --rates    plus 500 days of ARI
 *
 * The defaults above are their numbers. The 500 day grid varies around them,
 * because Channex reject data that looks like a placeholder while still
 * expecting these as the base rates.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const db = createClient(url, key, { auth: { persistSession: false } });
const withRates = process.argv.includes("--rates");

const PROPERTY_NAME = "Test Property - YourFrontDesk";

// Unit counts are chosen so every availability figure the scenarios ask for is
// reachable: test 9 wants Twin at 8 falling to 7, test 10 wants Double at 4.
const ROOM_TYPES = [
  { name: "Twin Room",   units: 8, sleeps: 2, sort: 0 },
  { name: "Double Room", units: 4, sleeps: 2, sort: 1 },
];

const RATE_PLANS = [
  { name: "Best Available Rate",  rate: 100, primary: true },
  { name: "Bed & Breakfast Rate", rate: 120, primary: false },
];

async function upsert(table, match, row) {
  const { data: found } = await db.from(table).select("*").match(match).maybeSingle();
  if (found) return found;
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

const account = await upsert("accounts", { slug: "yfd-certification" }, {
  name: "YourFrontDesk Certification",
  slug: "yfd-certification",
});
console.log("account", account.name, account.id);

const property = await upsert("properties", { account_id: account.id, name: PROPERTY_NAME }, {
  account_id: account.id,
  name: PROPERTY_NAME,
  currency: "USD",
  timezone: "Europe/Gibraltar",
});
console.log("property", property.name, property.id);

const plans = [];
for (const rt of ROOM_TYPES) {
  const roomType = await upsert("room_types", { property_id: property.id, name: rt.name }, {
    property_id: property.id,
    name: rt.name,
    count_of_rooms: rt.units,
    occ_adults: rt.sleeps,
    occ_children: 0,
    occ_infants: 0,
    default_occupancy: rt.sleeps,
    sort: rt.sort,
  });
  for (const rp of RATE_PLANS) {
    const plan = await upsert("rate_plans", { room_type_id: roomType.id, name: rp.name }, {
      room_type_id: roomType.id,
      name: rp.name,
      occupancy: rt.sleeps,
      is_primary: rp.primary,
    });
    plans.push({ roomType, plan, rate: rp.rate, primary: rp.primary });
  }
  console.log(`  ${rt.name}, ${rt.units} units, sleeps ${rt.sleeps}`);
}

// Stable pseudo-randomness so a re-seed reproduces the numbers a submitted
// task id was taken against.
function jitter(date, salt) {
  let h = 2166136261;
  for (const ch of `${date}${salt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const SEASON = { 0: 0.86, 1: 0.88, 2: 0.94, 3: 1.0, 4: 1.05, 5: 1.12, 6: 1.18, 7: 1.2, 8: 1.1, 9: 1.0, 10: 0.92, 11: 0.88 };

function rateFor(base, date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  let price = base * SEASON[d.getUTCMonth()];
  if (dow === 5 || dow === 6) price *= 1.15;
  else if (dow === 0) price *= 0.95;
  price *= 0.95 + jitter(date, "r") * 0.1;
  return Math.round(price);
}

function availabilityFor(units, date, salt) {
  const j = jitter(date, salt);
  if (j < 0.1) return 0;
  if (j < 0.45) return Math.max(1, units - Math.ceil(j * units));
  if (j < 0.65) return Math.max(1, units - 1);
  return units;
}

function minStayFor(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const peak = d.getUTCMonth() >= 5 && d.getUTCMonth() <= 8;
  if (peak && (dow === 5 || dow === 6)) return 2;
  return 1;
}

if (withRates) {
  const DAYS = 500;
  const start = new Date();
  const rows = [];
  for (const { roomType, plan, rate, primary } of plans) {
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const avail = availabilityFor(roomType.count_of_rooms, date, roomType.id);
      // Availability belongs to the room type, so only the primary plan lays it.
      if (primary) {
        rows.push({
          property_id: property.id,
          room_type_id: roomType.id,
          rate_plan_id: null,
          date,
          availability: avail,
        });
      }
      const minStay = minStayFor(date);
      rows.push({
        property_id: property.id,
        room_type_id: roomType.id,
        rate_plan_id: plan.id,
        date,
        rate: rateFor(rate, date),
        min_stay_arrival: minStay,
        min_stay_through: minStay,
        stop_sell: avail === 0,
        closed_to_arrival: minStay > 1 && jitter(date, "cta") < 0.1,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("ari").upsert(chunk, { onConflict: "room_type_id,rate_plan_id,date" });
    if (error) throw new Error(`ari: ${error.message}`);
    process.stdout.write(`\r  laid ${Math.min(i + 500, rows.length)} of ${rows.length} cells`);
  }
  console.log("\n  now provision, then run a full sync");
}

console.log("\nproperty id " + property.id);
