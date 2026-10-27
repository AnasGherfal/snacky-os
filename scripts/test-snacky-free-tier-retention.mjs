import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql=readFileSync("scripts/sql/snacky-free-tier-stock-retention.sql","utf8");

test("emergency Free-tier XY storage guard stays read-only for business ledgers",()=>{
  assert.match(sql,/snacky-xy-stock-retention/);
  assert.match(sql,/cron\.schedule\(/);
  assert.match(sql,/FROM public\.latest_vms_stock_by_slot/);
  assert.match(sql,/NOT EXISTS \(SELECT 1 FROM protected_latest/);
  assert.match(sql,/s\.source_provider = 'xy'/);
  assert.match(sql,/s\.import_row_status = 'imported'/);
  assert.match(sql,/s\.captured_at < now\(\) - interval '12 hours'/);
  assert.match(sql,/s\.captured_at >= now\(\) - interval '29 days'/);
  assert.match(sql,/extract\(hour FROM s\.captured_at AT TIME ZONE 'UTC'\)::int % 6 = 0/);
  assert.match(sql,/LIMIT 12000/);
  assert.match(sql,/DELETE FROM public\.vms_stock_snapshots/);
  assert.doesNotMatch(sql,/\b(?:delete|truncate|drop|update)\s+(?:from\s+)?(?:public\.)?(?:vms_transactions_raw|inventory_movements|financial_transactions|cash_collections|routes|route_stop_items)\b/i);
  assert.doesNotMatch(sql,/TRUNCATE\s+public\.vms_stock_snapshots|CASCADE/i);
});

test("independent cron safeguards clean only temporary logs and reuse snapshot storage",()=>{
  assert.match(sql,/snacky-xy-stock-vacuum/);
  assert.match(sql,/VACUUM \(ANALYZE\) public\.vms_stock_snapshots/);
  assert.match(sql,/snacky-cron-execution-log-retention/);
  assert.match(sql,/DELETE FROM cron\.job_run_details/);
  assert.match(sql,/start_time < now\(\) - interval '7 days'/);
  assert.doesNotMatch(sql,/ALTER ROLE|GRANT\s+ALL|pg_terminate_backend|vacuum full/i);
});

test("recovery policy distinguishes current stock, historical sample and archive limits",()=>{
  // This is a contract test for the policy represented above, not a replay
  // of the 2026-10-27 production cleanup or a simulation of sales.
  const now=new Date("2026-10-27T18:00:00Z");
  const protectedIds=new Set(["published-current"]);
  function retained({id,capturedAt}) {
    if(protectedIds.has(id))return true;
    const date=new Date(capturedAt),age=now.getTime()-date.getTime();
    if(age<=12*60*60*1000)return true;
    const h=date.getUTCHours(),m=date.getUTCMinutes(),doy=Math.floor((date.getTime()-Date.UTC(date.getUTCFullYear(),0,1))/86400000)+1;
    if(age<=29*86400000)return h%6===0&&m<10;
    return h===0&&m<10&&doy%7===0;
  }
  assert.equal(retained({id:"published-current",capturedAt:"2026-05-23T06:20:00Z"}),true);
  assert.equal(retained({id:"recent",capturedAt:"2026-10-27T16:23:00Z"}),true);
  assert.equal(retained({id:"six-hour-sample",capturedAt:"2026-10-25T12:00:00Z"}),true);
  assert.equal(retained({id:"old-10m",capturedAt:"2026-10-25T12:20:00Z"}),false);
});
