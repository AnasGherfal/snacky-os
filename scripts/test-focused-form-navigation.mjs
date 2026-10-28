import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source=readFileSync("src/components/module-tabs-config.ts","utf8");
const layout=readFileSync("src/components/ModuleTabsLayout.tsx","utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};
vm.runInNewContext(js,{exports,require(name){
  if(name==="@/components/app-navigation")return {getAppModuleKey:()=>null};
  throw new Error("Unexpected import "+name);
}});
const {isFocusedWorkFormPath}=exports;

test("new/edit work screens are focused without unrelated module tab chrome",()=>{
  for(const pathname of [
    "/routes/new","/routes/a/edit","/purchases/new","/purchases/a/edit",
    "/products/new","/products/a/edit","/machines/new","/machines/a/edit",
    "/issues/new","/issues/a/edit","/finance/transactions/new",
    "/finance/transactions/a/edit","/cash-collections/new","/cash-collections/a/edit",
    "/locations-pipeline/new","/locations-pipeline/a/edit",
    "/inventory/movements/new","/team/new","/team/a/edit",
    "/suppliers/new","/storage-locations/new","/storage-locations/a/edit",
    "/locations/new","/machine-slots/new","/machine-slots/a/edit",
    "/contacts/new","/follow-ups/new","/relationships/obligations/new",
  ])assert.equal(isFocusedWorkFormPath(pathname),true,pathname);
  assert.match(layout,/!isFocusedWorkFormPath\(pathname\)/);
});

test("list, overview and monitoring pages keep authorized navigation",()=>{
  for(const pathname of [
    "/routes","/routes/a","/inventory","/inventory/stocktake",
    "/purchases","/products","/machines","/machines/status",
    "/issues","/follow-ups","/finance","/finance/liquidity",
    "/finance/transactions","/admin","/admin/vms-api",
    "/operations-health","/cash-collections","/cash-handling",
    "/locations-pipeline","/my-work",
  ])assert.equal(isFocusedWorkFormPath(pathname),false,pathname);
});

test("path matching never hides list pages with similar prefixes",()=>{
  for(const pathname of ["/routes/new-archive","/machines/newest","/purchases/newest",
    "/finance/transactions/newest","/issues/news","/cash-collections/new-note"]) {
    assert.equal(isFocusedWorkFormPath(pathname),false,pathname);
  }
});
