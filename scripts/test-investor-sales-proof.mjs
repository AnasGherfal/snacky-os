import assert from "node:assert/strict";
import test from "node:test";
import {reconcileInvestorSalesSources} from "../src/lib/investor-sales-proof.ts";

test("active XY and historical inventory costs provide source-backed manual sale COGS",()=>{
 const proof=reconcileInvestorSalesSources({
  months:["2026-07-01"],
  batches:[{id:"july",report_start_date:"2026-07-01",report_end_date:"2026-07-31"}],
  xyRows:[{id:"xy",import_batch_id:"july",business_month:"2026-07-01",
   transaction_amount:100,cost_amount:60}],
  manualSales:[
   {id:"linked",sale_time:"2026-07-16T10:00:00Z",status:"confirmed",
    product_id:"water",product_name:"Water",quantity:1,total_amount_lyd:1,inventory_movement_id:"linked-move"},
   {id:"unlinked",sale_time:"2026-07-17T10:00:00Z",status:"confirmed",
    product_id:"water",product_name:"Water",quantity:2,total_amount_lyd:2,inventory_movement_id:null},
   {id:"legacy",sale_time:"2026-07-18T10:00:00Z",status:"confirmed",
    product_id:null,product_name:"Water",quantity:2,total_amount_lyd:2,inventory_movement_id:null}
  ],
  movements:[
   {id:"linked-move",product_id:"water",created_at:"2026-07-15T10:00:00Z",line_total_lyd:0.42,unit_cost_lyd:0.42},
   {id:"historic",product_id:"water",created_at:"2026-07-14T10:00:00Z",line_total_lyd:4.2,unit_cost_lyd:0.42}
  ],
  products:[{id:"water",name:"Water"},{id:"watermelon",name:"Bebeto Watermelon"}]
 });
 assert.equal(proof["2026-07-01"].revenueLyd,105);
 assert.equal(proof["2026-07-01"].cogsLyd,62.1);
 assert.equal(proof["2026-07-01"].grossProfitLyd,42.9);
 assert.equal(proof["2026-07-01"].datedCostMatches,2);
 assert.equal(proof["2026-07-01"].unresolvedCostCount,0);
});
test("an unlinked sale without dated cost evidence cannot generate a monthly share",()=>{
 const proof=reconcileInvestorSalesSources({
  months:["2026-07-01"],
  batches:[{id:"july",report_start_date:"2026-07-01",report_end_date:"2026-07-31"}],
  xyRows:[{import_batch_id:"july",business_month:"2026-07-01",transaction_amount:100,cost_amount:60}],
  manualSales:[{id:"unknown",sale_time:"2026-07-20T00:00:00Z",status:"confirmed",
   product_id:null,product_name:"Unknown",quantity:2,total_amount_lyd:5,inventory_movement_id:null}],
  movements:[],products:[]
 });
 assert.equal(proof["2026-07-01"].grossProfitLyd,null);
 assert.equal(proof["2026-07-01"].unresolvedCostCount,1);
});
