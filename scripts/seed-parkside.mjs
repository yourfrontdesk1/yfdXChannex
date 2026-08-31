#!/usr/bin/env node
/**
 * Seeds the first account and property: Victory Suites Parkside, the second
 * Booking.com listing at 9 Devil's Tower Road. Structure only by default.
 *
 *   node scripts/seed-parkside.mjs            structure
 *   node scripts/seed-parkside.mjs --rates    also lay 500 days of rate at the
 *                                             achieved ADR, ready for a full sync
 *
 * Rates are the ADR these same apartments made on the main listing over the 90
 * days to 31 August 2026, not guesses.
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
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
const withRates = process.argv.includes("--rates");

const CHANNEX_PROPERTY_ID = "5bb09c14-3566-4d29-bfc8-1553dfefa5d2";

// These Channex ids already exist on staging. They are adopted rather than
// created, because provisioning against an already provisioned property makes a
// second set of everything.
const ROOM_TYPES = [
  { name: "Studio Apartment",      code: "1717679004", units: 3, sleeps: 2, rate: 92,  apartments: "3.17A, 4.17A, 8.17A",
    channex_room_type_id: "e68516e2-2e95-4f42-b4d6-a08df112897f",
    channex_rate_plan_id: "bb103248-58c7-4a0a-b6ed-f51f48b53681" },
  { name: "Executive Studio",      code: "1717679003", units: 5, sleeps: 3, rate: 98,  apartments: "1.11, 2.05, 7.08, 7.18, 9.17B",
    channex_room_type_id: "5e64144e-9c7b-4dd6-b74e-4b06f86408de",
    channex_rate_plan_id: "69a9b518-4c08-4a64-aff3-f8621a3c5779" },
  { name: "One Bedroom Apartment", code: "1717679001", units: 3, sleeps: 4, rate: 99,  apartments: "1.14, 3.17B, 4.17B",
    channex_room_type_id: "7fbf0e25-76a5-491e-90de-55a28f68b7ad",
    channex_rate_plan_id: "c885bde4-2760-479d-8df7-d1c313c46d9b" },
  { name: "Two Bedroom Apartment", code: "1717679002", units: 1, sleeps: 5, rate: 120, apartments: "2.17",
    channex_room_type_id: "85fc28f7-5e80-4e3a-b3e1-1d1a623de039",
    channex_rate_plan_id: "00ca626f-41ae-4921-8a83-bb25b2641f95" },
];

async function upsert(table, match, row) {
  const { data: found } = await db.from(table).select("*").match(match).maybeSingle();
  if (found) return found;
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

const account = await upsert("accounts", { slug: "victory-suites" }, {
  name: "Victory Suites",
  slug: "victory-suites",
});
console.log("account", account.name, account.id);

const property = await upsert("properties", { account_id: account.id, name: "Victory Suites Parkside" }, {
  account_id: account.id,
  name: "Victory Suites Parkside",
  currency: "GBP",
  timezone: "Europe/Gibraltar",
  channex_property_id: CHANNEX_PROPERTY_ID,
});
console.log("property", property.name, property.id);

const plans = [];
for (const [i, rt] of ROOM_TYPES.entries()) {
  const roomType = await upsert("room_types", { property_id: property.id, name: rt.name }, {
    property_id: property.id,
    name: rt.name,
    count_of_rooms: rt.units,
    occ_adults: rt.sleeps,
    occ_children: 0,
    occ_infants: 0,
    default_occupancy: rt.sleeps,
    ota_room_type_code: rt.code,
    channex_room_type_id: rt.channex_room_type_id,
    sort: i,
  });
  const plan = await upsert("rate_plans", { room_type_id: roomType.id, name: "Best Available Rate" }, {
    room_type_id: roomType.id,
    name: "Best Available Rate",
    occupancy: rt.sleeps,
    is_primary: true,
    channex_rate_plan_id: rt.channex_rate_plan_id,
  });
  plans.push({ roomType, plan, rate: rt.rate });
  console.log(`  ${rt.name}, ${rt.units} units, sleeps ${rt.sleeps}, ${rt.apartments}`);
}

if (withRates) {
  const DAYS = 500;
  const start = new Date();
  const rows = [];
  for (const { roomType, plan, rate } of plans) {
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      rows.push({
        property_id: property.id,
        room_type_id: roomType.id,
        rate_plan_id: null,
        date,
        availability: roomType.count_of_rooms,
      });
      rows.push({
        property_id: property.id,
        room_type_id: roomType.id,
        rate_plan_id: plan.id,
        date,
        rate,
        min_stay_arrival: 1,
        min_stay_through: 1,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("ari").upsert(chunk, { onConflict: "room_type_id,rate_plan_id,date" });
    if (error) throw new Error(`ari: ${error.message}`);
    process.stdout.write(`\r  laid ${Math.min(i + 500, rows.length)} of ${rows.length} cells`);
  }
  console.log("\n  run a full sync rather than draining the outbox, it is one call each way");
}

console.log("\nOpen /grid/" + property.id);
