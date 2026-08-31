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

const ROOM_TYPES = [
  { name: "Studio Apartment",      code: "1717679004", units: 3, sleeps: 2, rate: 92,  apartments: "3.17A, 4.17A, 8.17A" },
  { name: "Executive Studio",      code: "1717679003", units: 5, sleeps: 3, rate: 98,  apartments: "1.11, 2.05, 7.08, 7.18, 9.17B" },
  { name: "One Bedroom Apartment", code: "1717679001", units: 3, sleeps: 4, rate: 99,  apartments: "1.14, 3.17B, 4.17B" },
  { name: "Two Bedroom Apartment", code: "1717679002", units: 1, sleeps: 5, rate: 120, apartments: "2.17" },
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
    sort: i,
  });
  const plan = await upsert("rate_plans", { room_type_id: roomType.id, name: "Best Available Rate" }, {
    room_type_id: roomType.id,
    name: "Best Available Rate",
    occupancy: rt.sleeps,
    is_primary: true,
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
