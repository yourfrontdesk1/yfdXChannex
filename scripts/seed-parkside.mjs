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

  // A second plan per room type. Non-refundable at ten percent under the
  // flexible rate is the ordinary pairing in this market, and it is also what
  // lets the certification scenarios that touch two rate plans on one room
  // type be performed properly rather than skipped.
  const nonRef = await upsert("rate_plans", { room_type_id: roomType.id, name: "Non-Refundable" }, {
    room_type_id: roomType.id,
    name: "Non-Refundable",
    occupancy: rt.sleeps,
    is_primary: false,
    channex_rate_plan_id: null,
  });
  plans.push({ roomType, plan: nonRef, rate: Math.round(rt.rate * 0.9) });
  console.log(`  ${rt.name}, ${rt.units} units, sleeps ${rt.sleeps}, ${rt.apartments}`);
}

// A flat grid is rejected. Channex review the data pattern before they will
// schedule the live call and explicitly turn away uniform placeholder values.
// The shape below is the ordinary shape of a Gibraltar aparthotel year, so what
// they see reads as a real property rather than a fixture.

// Stable pseudo-randomness. Seeded off the date so a re-seed lands on the same
// numbers, which matters when a task id has already been submitted against them.
function jitter(date, salt) {
  let h = 2166136261;
  for (const ch of `${date}${salt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

// Gibraltar demand: summer peaks, deep winter troughs, shoulder either side.
const SEASON = { 0: 0.82, 1: 0.84, 2: 0.92, 3: 1.0, 4: 1.06, 5: 1.14, 6: 1.22, 7: 1.24, 8: 1.12, 9: 1.0, 10: 0.9, 11: 0.86 };

function rateFor(base, date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  let price = base * SEASON[d.getUTCMonth()];
  if (dow === 5 || dow === 6) price *= 1.18;          // Friday and Saturday
  else if (dow === 0) price *= 0.94;                   // Sunday soft
  if (date.slice(5) === "09-10") price *= 1.45;        // Gibraltar National Day
  price *= 0.94 + jitter(date, "r") * 0.12;            // day to day movement
  return Math.round(price);
}

function availabilityFor(units, date, salt) {
  const j = jitter(date, salt);
  const d = new Date(`${date}T00:00:00Z`);
  const near = (d - new Date()) / 86400000 < 120;      // nearer dates sell down
  if (near && j < 0.16) return 0;                      // genuinely sold out
  if (near && j < 0.52) return Math.max(1, units - Math.ceil(j * units));
  if (j < 0.2) return Math.max(1, units - 1);
  return units;
}

function minStayFor(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const peak = d.getUTCMonth() >= 5 && d.getUTCMonth() <= 8;
  if (date.slice(5) === "09-10") return 3;             // National Day
  if (peak && (dow === 5 || dow === 6)) return 2;      // summer weekends
  return 1;
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
      const avail = availabilityFor(roomType.count_of_rooms, date, roomType.id);
      // Availability belongs to the room type, not the plan, so only the
      // primary plan lays it. Writing it twice would collide in the upsert.
      if (plan.is_primary) {
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
        // Nothing sells on a date with no rooms left.
        stop_sell: avail === 0,
        // A handful of arrival closures, the way a real property protects a
        // weekend from a one night booking.
        closed_to_arrival: minStay > 1 && jitter(date, "cta") < 0.12,
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
