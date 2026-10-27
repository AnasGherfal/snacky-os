import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadCompleteFinanceLedgerRows } from "../src/lib/finance-ledger.ts";

function row(id) {
  return { id: `id-${id}`, transaction_date: "2026-10-01", created_at: "2026-10-01T00:00:00Z", amount: 1, signed_amount: 1, direction: "money_in", account_id: "snacky_lyd", is_void: false };
}

test("Finance retrieves all 1,426 ledger rows across verified 500-row pages", async () => {
  const entries = Array.from({length:1426}, (_,i)=>row(i));
  const offsets=[];
  const result = await loadCompleteFinanceLedgerRows({
    label:"test",
    buildQuery:(_columns,_level,from,to) => {
      offsets.push([from,to]);
      return Promise.resolve({data:entries.slice(from,to+1),count:entries.length,error:null});
    },
  });
  assert.deepEqual(offsets,[[0,499],[500,999],[1000,1499]]);
  assert.equal(result.error,null);
  assert.equal(result.count,1426);
  assert.equal(result.data.length,1426);
  assert.equal(new Set(result.data.map(r=>r.id)).size,1426);
});

test("Finance does not trust a server capped to 100 rows when exact count is 1,426",async()=>{
  const result=await loadCompleteFinanceLedgerRows({
    label:"truncated",buildQuery:(_c,_l,from,_to)=>
      Promise.resolve({data:Array.from({length:100},(_,i)=>row(from+i)),count:1426,error:null}),
  });
  assert.ok(result.error);
  assert.equal(result.count,null);
  assert.deepEqual(result.data,[]);
  assert.match(String(result.error),/incomplete/);
});

test("Finance fails closed when exact count is unavailable",async()=>{
  const result=await loadCompleteFinanceLedgerRows({
    label:"unknown-count",buildQuery:()=>Promise.resolve({data:[row(1)],count:null,error:null}),
  });
  assert.ok(result.error);
  assert.deepEqual(result.data,[]);
  assert.match(String(result.error),/exact row count unavailable/);
});

test("Finance rejects changing row count between pages",async()=>{
  const result=await loadCompleteFinanceLedgerRows({
    label:"changing",
    buildQuery:(_c,_l,from,to)=>Promise.resolve({data:Array.from({length:Math.min(500,from===0?500:100)},(_,i)=>row(from+i)),count:from===0?600:601,error:null}),
  });
  assert.ok(result.error);
  assert.match(String(result.error),/changed during pagination/);
  assert.equal(result.data.length,0);
});

test("Finance rejects duplicate IDs even when page sizes appear complete",async()=>{
  const result=await loadCompleteFinanceLedgerRows({
    label:"duplicate",
    buildQuery:(_c,_l,from,to)=>Promise.resolve({
      data:Array.from({length:Math.min(500,750-from)},(_,i)=>row(from===0?i:(i===0?1:from+i))),
      count:750,error:null,
    }),
  });
  assert.ok(result.error);
  assert.match(String(result.error),/duplicate IDs/);
});

test("Finance falls back to stable columns for verified missing-column error only",async()=>{
  const levels=[];
  const result=await loadCompleteFinanceLedgerRows({
    label:"older-schema",
    buildQuery:(_c,level,from,to)=>{
      levels.push(level);
      if(level==="full")return Promise.resolve({data:null,count:null,error:{code:"42703",message:'column "updated_at" does not exist'}});
      return Promise.resolve({data:[row(0)],count:1,error:null});
    },
  });
  assert.deepEqual(levels,["full","stable"]);
  assert.equal(result.error,null);
  assert.equal(result.level,"stable");
  assert.equal(result.data.length,1);
  assert.ok(result.warning);
});

test("Finance never schema-falls-back on a permission failure",async()=>{
  const levels=[];
  const result=await loadCompleteFinanceLedgerRows({
    label:"denied",
    buildQuery:(_c,level)=>{levels.push(level);return Promise.resolve({data:null,count:null,error:{code:"42501",message:"permission denied"}})},
  });
  assert.deepEqual(levels,["full"]);
  assert.ok(result.error);
});

test("Finance overview and growth decision use exact count and stable pagination",()=>{
  const finance=readFileSync("src/app/finance/page.tsx","utf8");
  const growth=readFileSync("src/app/finance/growth-decisions/page.tsx","utf8");
  for(const page of [finance,growth]){
    assert.ok(page.includes("loadCompleteFinanceLedgerRows({"));
    assert.ok(page.includes('{ count: "exact" }'));
    assert.ok(page.includes('.order("created_at", { ascending: true })'));
    assert.ok(page.includes('.order("id", { ascending: true })'));
    assert.ok(page.includes('.range(from, to)'));
  }
  assert.ok(finance.includes('title="Finance totals unavailable"'));
  assert.ok(finance.includes("No partial or opening-balance-only total will be shown"));
  assert.ok(growth.includes("if (ledgerResult.error)"));
});
