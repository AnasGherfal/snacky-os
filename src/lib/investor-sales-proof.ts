/**
 * Independent, source-backed investor sales reconciliation.
 * Uses the one active complete XY monthly import, actual confirmed manual
 * route sales and dated inventory movement costs. Never substitutes today's
 * catalog price for historical cost and never changes stock quantities.
 */
export type ActiveXyBatch = {
 id:string;report_start_date:string;report_end_date:string;
};
export type XyProfitRow = {
 id?:string;import_batch_id:string;business_month:string;
 transaction_amount:number|string|null;cost_amount:number|string|null;
};
export type ManualInvestorSale = {
 id:string;sale_time:string;status:string;
 product_id:string|null;product_name:string|null;
 quantity:number|string|null;total_amount_lyd:number|string|null;
 inventory_movement_id:string|null;needs_review?:boolean|null;
};
export type DatedInventoryCost = {
 id:string;product_id:string|null;created_at?:string|null;
 line_total_lyd?:number|string|null;unit_cost_lyd?:number|string|null;
};
export type ProductNameRef = {id:string;name:string|null};
export type InvestorSalesProof = {
 month:string;revenueLyd:number|null;cogsLyd:number|null;grossProfitLyd:number|null;
 xyRows:number;manualSales:number;datedCostMatches:number;
 missingInventoryMovements:number;unresolvedCostCount:number;
 sourceIssues:string[];
};
const money=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const numeric=(v:unknown):number|null=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?null:Number(v);
const normalized=(v:unknown)=>String(v??"").toLowerCase().normalize("NFKC")
 .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"").replace(/\s+/g," ").trim();
const validMonth=(m:string)=>/^\d{4}-(0[1-9]|1[0-2])-01$/.test(m);
const monthEnd=(m:string)=>new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5,7)),0)).toISOString().slice(0,10);
const monthOf=(v:string)=>String(v??"").slice(0,7)+"-01";

export function reconcileInvestorSalesSources({
 months,batches,xyRows,manualSales,movements,products
}:{months:string[];batches:ActiveXyBatch[];xyRows:XyProfitRow[];
 manualSales:ManualInvestorSale[];movements:DatedInventoryCost[];
 products:ProductNameRef[]}):Record<string,InvestorSalesProof>{
 const result:Record<string,InvestorSalesProof>={};
 const byBatch=new Map<string,XyProfitRow[]>();
 for(const r of xyRows)byBatch.set(r.import_batch_id,[...(byBatch.get(r.import_batch_id)??[]),r]);
 const byMovement=new Map(movements.map(m=>[m.id,m]));
 const byProduct=new Map<string,DatedInventoryCost[]>();
 for(const m of movements){
  if(!m.product_id||numeric(m.unit_cost_lyd)===null||Number(m.unit_cost_lyd)<=0||!m.created_at)continue;
  byProduct.set(m.product_id,[...(byProduct.get(m.product_id)??[]),m]);
 }
 for(const records of byProduct.values())records.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
 const byName=new Map<string,ProductNameRef[]>();
 for(const p of products)byName.set(normalized(p.name),[...(byName.get(normalized(p.name))??[]),p]);
 for(const month of months){
  if(!validMonth(month))continue;
  const issues:string[]=[];
  const active=batches.filter(b=>b.report_start_date<=month&&b.report_end_date>=monthEnd(month));
  if(active.length!==1)issues.push("Exactly one active full-month XY report required");
  const xy=active.length===1?(byBatch.get(active[0].id)??[]):[];
  if(!xy.length)issues.push("No active XY monthly product profit rows");
  let revenue=0,cost=0,unresolvedCostCount=0,datedCostMatches=0,missingInventoryMovements=0;
  for(const row of xy){
   const sales=numeric(row.transaction_amount),cogs=numeric(row.cost_amount);
   if(sales===null||cogs===null||sales<0||cogs<0){
    unresolvedCostCount++;continue;
   }
   revenue+=sales;cost+=cogs;
  }
  const monthManual=manualSales.filter(s=>s.status==="confirmed"&&monthOf(s.sale_time)===month);
  for(const sale of monthManual){
   const sales=numeric(sale.total_amount_lyd),qty=numeric(sale.quantity);
   if(sales===null||qty===null||qty<=0||!Number.isInteger(qty)||sales<0){
    unresolvedCostCount++;continue;
   }
   revenue+=sales;
   const linked=sale.inventory_movement_id?byMovement.get(sale.inventory_movement_id):null;
   let actualCost=numeric(linked?.line_total_lyd);
   if(actualCost===null||actualCost<=0){
    const unit=numeric(linked?.unit_cost_lyd);
    actualCost=unit!==null&&unit>0?money(unit*qty):null;
   }
   if(actualCost===null||actualCost<=0){
    missingInventoryMovements++;
    let productId=sale.product_id;
    if(!productId){
     const matches=byName.get(normalized(sale.product_name))??[];
     if(matches.length===1)productId=matches[0].id;
    }
    const previous=(byProduct.get(productId??"")??[])
     .find(m=>String(m.created_at)<=String(sale.sale_time)&&Number(m.unit_cost_lyd)>0);
    if(previous){
     actualCost=money(Number(previous.unit_cost_lyd)*qty);
     datedCostMatches++;
    }else unresolvedCostCount++;
   }
   if(actualCost!==null&&actualCost>0)cost+=actualCost;
  }
  if(unresolvedCostCount>0)issues.push("Sales product cost source missing for "+unresolvedCostCount+" row(s)");
  result[month]={month,revenueLyd:issues.length?null:money(revenue),
   cogsLyd:issues.length?null:money(cost),
   grossProfitLyd:issues.length?null:money(revenue-cost),
   xyRows:xy.length,manualSales:monthManual.length,datedCostMatches,
   missingInventoryMovements,unresolvedCostCount,sourceIssues:issues};
 }
 return result;
}
