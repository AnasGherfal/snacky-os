import test from "node:test";
import assert from "node:assert/strict";
import {assessXyMachineActivity,XY_MACHINE_ACTIVITY_PROFILES} from "../src/lib/xy-stock-activity-alert-rules.ts";
import fs from "node:fs";

const DAY=86400000;
const iso=(ms)=>new Date(ms).toISOString().slice(0,10);
function shift(day,offset){return iso(Date.parse(day+"T00:00:00Z")+offset*DAY);}
function buildHistory(nowMs,{hours=[11,12,13,14],days=14,weekdayOnly=false,usualUnits=3,currentUnits=0}={}) {
  const currentDay=iso(nowMs+2*3600000);
  const hourly=[];
  for(let previous=0;previous<=days;previous++) {
    const day=shift(currentDay,-previous);
    if(previous && weekdayOnly && new Date(day+"T12:00:00Z").getUTCDay()!==new Date(currentDay+"T12:00:00Z").getUTCDay()) continue;
    for(const hour of hours)hourly.push({
      day,hour,units:previous===0?currentUnits:usualUnits,
      events:previous===0?0:2,batches:5,slots:35,
    });
  }
  return {
    machine_id:"m-test",last_observed_at:new Date(nowMs-3*60*1000).toISOString(),
    last_decrease_at:new Date(nowMs-8*3600000).toISOString(),
    recent_slots:35,recent_stocked_slots:29,hourly,
  };
}

test("Istiklal hospital: four active hours without stock movement trigger a historically supported review",()=>{
  // Friday Oct 9, 15:05 Tripoli => UTC 13:05, completed hours 11..14.
  const now=Date.parse("2026-10-09T13:05:00Z");
  const history=buildHistory(now);
  const r=assessXyMachineActivity({
    nowMs:now,profile:XY_MACHINE_ACTIVITY_PROFILES["2509000369"],history,
  });
  assert.equal(r.outcome,"attention");
  assert.equal(r.hours,4);
  assert.equal(r.kind,"hospital");
  assert.equal(r.usualUnits,12);
  assert.equal(r.evidenceDays,14);
});

test("Almouasafat hospital: normal night-time quiet periods must not alert",()=>{
  // 04:05 local, most nights have no stock movement from 00:00 to 03:59.
  const now=Date.parse("2026-10-09T02:05:00Z");
  const history=buildHistory(now,{hours:[0,1,2,3],usualUnits:0});
  const r=assessXyMachineActivity({nowMs:now,profile:XY_MACHINE_ACTIVITY_PROFILES["2411000046"],history});
  assert.equal(r.outcome,"skip");
  assert.equal(r.reason,"normal_quiet_period");
});

test("Hospital: unreliable stock, unavailable capacity and recent activity suppress alerts",()=>{
  const now=Date.parse("2026-10-09T13:05:00Z");
  const history=buildHistory(now);
  const profile=XY_MACHINE_ACTIVITY_PROFILES["2509000369"];
  assert.equal(assessXyMachineActivity({nowMs:now,profile,history:{...history,recent_stocked_slots:0}}).outcome,"skip");
  assert.equal(assessXyMachineActivity({nowMs:now,profile,history:{...history,last_observed_at:new Date(now-2*3600000).toISOString()}}).outcome,"skip");
  const changed={...history,hourly:history.hourly.map(x=>x.day===iso(now+2*3600000)&&x.hour===13?{...x,units:1}:x)};
  assert.equal(assessXyMachineActivity({nowMs:now,profile,history:changed}).reason,"recent_inventory_change");
});

test("Campuses close Fridays and after-class hours; schools also close Saturdays",()=>{
  const friday=Date.parse("2026-10-09T13:05:00Z");
  const history=buildHistory(friday);
  for(const machineId of ["2509000370","2510001719","2511001702"]) {
    const profile=XY_MACHINE_ACTIVITY_PROFILES[machineId];
    assert.equal(assessXyMachineActivity({nowMs:friday,profile,history}).reason,"closed");
    assert.equal(assessXyMachineActivity({nowMs:friday+5*3600000,profile,history}).reason,"closed");
  }
  const saturday=Date.parse("2026-10-10T10:05:00Z");
  assert.equal(assessXyMachineActivity({
    nowMs:saturday,profile:XY_MACHINE_ACTIVITY_PROFILES["2511001702"],history,
  }).reason,"closed");
  // University Saturday hours are open by default *only* if actual historical
  // Saturday demand subsequently supports an alert.
  assert.ok(XY_MACHINE_ACTIVITY_PROFILES["2510001719"].open[6]);
});

test("University weekdays alert when same weekday historically had busy classroom hours",()=>{
  const now=Date.parse("2026-10-12T10:05:00Z"); // Monday 12:05 Tripoli.
  const history=buildHistory(now,{hours:[9,10,11],days:28,weekdayOnly:true,usualUnits:4});
  const r=assessXyMachineActivity({nowMs:now,profile:XY_MACHINE_ACTIVITY_PROFILES["2509000370"],history});
  assert.equal(r.outcome,"attention");
  assert.equal(r.hours,3);
  assert.equal(r.evidenceDays,4);
});

test("University temporary holiday can be excluded from monitoring",()=>{
  const now=Date.parse("2026-10-12T10:05:00Z");
  const profile={...XY_MACHINE_ACTIVITY_PROFILES["2509000370"],closedDates:["2026-10-12"]};
  const r=assessXyMachineActivity({nowMs:now,profile,history:buildHistory(now)});
  assert.equal(r.reason,"closed");
});

test("Malls use a different, same-weekday history and Friday later opening",()=>{
  const now=Date.parse("2026-10-09T18:05:00Z"); // 20:05 local Friday; completed 17..19.
  const profile=XY_MACHINE_ACTIVITY_PROFILES["2509000371"];
  const history=buildHistory(now,{hours:[17,18,19],days:28,weekdayOnly:true,usualUnits:2});
  const r=assessXyMachineActivity({nowMs:now,profile,history});
  assert.equal(r.outcome,"attention");
  assert.equal(r.kind,"mall");
  assert.equal(r.hours,3);
  assert.equal(r.usualUnits,6);
  assert.equal(assessXyMachineActivity({
    nowMs:Date.parse("2026-10-09T11:05:00Z"),
    profile,history,
  }).reason,"closed");
});

test("Malls do not alert on historically slow periods or insufficient same-weekday observations",()=>{
  const now=Date.parse("2026-10-09T18:05:00Z");
  const profile=XY_MACHINE_ACTIVITY_PROFILES["2503000217"];
  const low=buildHistory(now,{hours:[17,18,19],days:28,weekdayOnly:true,usualUnits:0});
  assert.equal(assessXyMachineActivity({nowMs:now,profile,history:low}).reason,"normal_quiet_period");
  const sparse=buildHistory(now,{hours:[17,18,19],days:7,weekdayOnly:true,usualUnits:5});
  assert.equal(assessXyMachineActivity({nowMs:now,profile,history:sparse}).reason,"insufficient_history");
});

test("Cron path stores only conservative in-app inventory inactivity warnings, never 'no sales'",()=>{
  const alerts=fs.readFileSync("src/lib/xy-stock-activity-alerts.ts","utf8");
  const worker=fs.readFileSync("src/lib/xy-operational-alerts.ts","utf8");
  assert.match(worker,/getXyStockActivityNotices/);
  assert.match(alerts,/xy_stock_activity_gap/);
  assert.match(alerts,/it does NOT prove zero sales/);
  assert.doesNotMatch(alerts,/sendPush|sendEmail|webpush/);
  assert.match(alerts,/snacky_xy_stock_activity_history/);
});
