import { readFileSync } from "node:fs";
import { connectExpedia, type ExpediaRoomPair } from "./src/lib/provision";
for (const line of readFileSync(".env.local","utf8").split("\n")) { const m=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^["']|["']$/g,"").trim(); }
const PID="1041eaa6-f85a-4dad-ad43-a215a0e9ef43";
const pairing: ExpediaRoomPair[] = [
  { hubRoomType:"studio other floors", expediaRoomId:"328344922", expediaRatePlanCode:"408572273", expediaMaxOccupancy:2 },
  { hubRoomType:"Studios 6TH Floor", expediaRoomId:"328344926", expediaRatePlanCode:"408572249", expediaMaxOccupancy:2 },
  { hubRoomType:"Studio 10th 11th floor", expediaRoomId:"328346703", expediaRatePlanCode:"408572261", expediaMaxOccupancy:2 },
  { hubRoomType:"Exec Studio", expediaRoomId:"328346783", expediaRatePlanCode:"408572417", expediaMaxOccupancy:4 },
  { hubRoomType:"Exec Studio 6th Floor", expediaRoomId:"328346724", expediaRatePlanCode:"408572301", expediaMaxOccupancy:4 },
  { hubRoomType:"Exec Studio 10th 11th floor", expediaRoomId:"328346738", expediaRatePlanCode:"408572350", expediaMaxOccupancy:3 },
  { hubRoomType:"1 bed", expediaRoomId:"328346808", expediaRatePlanCode:"408572454", expediaMaxOccupancy:4 },
  { hubRoomType:"1 bed 6th floor", expediaRoomId:"328346817", expediaRatePlanCode:"408572472", expediaMaxOccupancy:4 },
  { hubRoomType:"1 bed 10th 11th floor", expediaRoomId:"328346829", expediaRatePlanCode:"408572492", expediaMaxOccupancy:4 },
  { hubRoomType:"2 bedroom apartment", expediaRoomId:"328346846", expediaRatePlanCode:"408572524", expediaMaxOccupancy:6 },
  { hubRoomType:"2 bed 6th floor", expediaRoomId:"328346867", expediaRatePlanCode:"408572536", expediaMaxOccupancy:6 },
  { hubRoomType:"2 bed on 10th 11th floor", expediaRoomId:"328346836", expediaRatePlanCode:"408572516", expediaMaxOccupancy:6 },
];
async function main(){
  const r:any = await connectExpedia(PID, "127426421", pairing);
  console.log("test_connection:", r.test_connection, "| channel_id:", r.channel_id, "| mapped:", r.mapped, "| err:", r.error);
  console.log("unmapped:", JSON.stringify(r.unmapped));
  console.log("occupancy_warnings:", JSON.stringify(r.occupancy_warnings ?? r.occupancyWarnings ?? []));
  const rd = r.readiness?.data ?? r.readiness;
  console.log("readiness:", Array.isArray(rd)? (rd.length? JSON.stringify(rd).slice(0,1500) : "[] ALL CLEAR") : JSON.stringify(rd).slice(0,1500));
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
