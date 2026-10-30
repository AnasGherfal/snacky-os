import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import {
 auditInvestorFinanceMoneyOut,
 type InvestorCashOutAudit,
 type InvestorFinanceOutflow
} from "@/lib/investor-finance-outflow";
import type { DatedCostPolicy } from "@/lib/investor-recorded-draft";
import {
 reconcileInvestorSalesSources,
 type ActiveXyBatch,type XyProfitRow,type ManualInvestorSale,
 type DatedInventoryCost,type ProductNameRef,type InvestorSalesProof
} from "@/lib/investor-sales-proof";

/** Scoped, aggregated Finance read only. Never hand raw company entries to
 * the investor page or use a service role before checking the agreement owner.
 */
export async function loadAuthorizedInvestorCashOutAudit({
 agreementId,investorUserId,startDate,endDate,months=[]
}:{agreementId:string;investorUserId:string;startDate:string;endDate?:string|null;months?:string[]}):Promise<{audit:InvestorCashOutAudit;policies:DatedCostPolicy[];salesByMonth:Record<string,InvestorSalesProof>}>{
 const profile=await getCurrentProfile();
 const session=await getAuthenticatedSupabaseServerClient();
 if(!profile||profile.active_status!=="active"||!session)
  throw new Error("Investor session unavailable.");
 const {data:agreement,error}=await session.from("investor_agreements")
  .select("id,investor_user_id").eq("id",agreementId).maybeSingle();
 if(error||!agreement||agreement.investor_user_id!==investorUserId)
  throw new Error("Investor agreement not accessible.");
 if(!isOwnerAdminRole(profile)&&agreement.investor_user_id!==profile.id)
  throw new Error("Investor finance summary not authorized.");
 const reader=getSupabaseAdminClient();
 if(!reader)throw new Error("Verified Finance reader unavailable.");
 const todayParts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",
  year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const today=["year","month","day"].map(k=>todayParts.find(p=>p.type===k)?.value??"").join("-");
 const from=startDate;
 const to=endDate && endDate<today?endDate:today;
 const rows:InvestorFinanceOutflow[]=[];
 const salesByMonth:Record<string,InvestorSalesProof>={};
 if(months.length){
  const first=[...months].sort()[0],last=[...months].sort().at(-1)!;
  const endNext=new Date(Date.UTC(Number(last.slice(0,4)),Number(last.slice(5,7)),1)).toISOString().slice(0,10);
  const all=async<T>(builder:(from:number,to:number)=>any):Promise<T[]>=>{
   const found:T[]=[];
   for(let offset=0;offset<20000;offset+=500){
    const q=await builder(offset,offset+499);
    if(q.error)throw new Error("Verified investor sales source unavailable.");
    const page=(q.data??[]) as T[];found.push(...page);
    if(page.length<500)return found;
   }
   throw new Error("Investor sales source exceeded complete-read limit.");
  };
  const batches=await all<ActiveXyBatch>((from,to)=>reader.from("vms_import_batches")
   .select("id,report_start_date,report_end_date").eq("report_type","monthly_product_profit")
   .eq("is_active",true).eq("status","imported")
   .lte("report_start_date",last).gte("report_end_date",first).order("id").range(from,to));
  const batchIds=batches.map(b=>b.id);
  const xyRows=batchIds.length?await all<XyProfitRow>((from,to)=>reader.from("vms_monthly_product_profit")
   .select("id,import_batch_id,business_month,transaction_amount,cost_amount")
   .in("import_batch_id",batchIds).gte("business_month",first).lte("business_month",last)
   .order("id").range(from,to)):[];
  const manual=await all<ManualInvestorSale>((from,to)=>reader.from("route_manual_sales")
   .select("id,sale_time,status,product_id,product_name,quantity,total_amount_lyd,inventory_movement_id,needs_review")
   .eq("status","confirmed").gte("sale_time",first+"T00:00:00+02:00")
   .lt("sale_time",endNext+"T00:00:00+02:00").order("id").range(from,to));
  const linkedIds=[...new Set(manual.map(m=>m.inventory_movement_id).filter((x):x is string=>Boolean(x)))];
  const movements:DatedInventoryCost[]=[];
  for(let i=0;i<linkedIds.length;i+=200){
   const q=await reader.from("inventory_movements")
    .select("id,product_id,created_at,line_total_lyd,unit_cost_lyd")
    .in("id",linkedIds.slice(i,i+200));
   if(q.error)throw new Error("Manual sales linked inventory cost unavailable.");
   movements.push(...(q.data??[]) as DatedInventoryCost[]);
  }
  const unlinkedProductIds=[...new Set(manual.filter(m=>!m.inventory_movement_id&&m.product_id).map(m=>m.product_id!))];
  for(let i=0;i<unlinkedProductIds.length;i+=100){
   const ids=unlinkedProductIds.slice(i,i+100);
   movements.push(...await all<DatedInventoryCost>((from,to)=>reader.from("inventory_movements")
    .select("id,product_id,created_at,line_total_lyd,unit_cost_lyd")
    .in("product_id",ids).gt("unit_cost_lyd",0)
    .lt("created_at",endNext+"T00:00:00+02:00")
    .order("created_at").order("id").range(from,to)));
  }
  // A legacy sale may have no product ID. Match a unique exact catalog name
  // and then require dated stock-cost evidence; never infer a price from text.
  const products=manual.some(m=>!m.product_id)
   ?await all<ProductNameRef>((from,to)=>reader.from("products").select("id,name").order("id").range(from,to))
   :[];
  const missingIds=manual.filter(m=>!m.product_id);
  if(missingIds.length){
   const clean=(x:string)=>x.toLowerCase().normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"").trim();
   const resolvedIds=missingIds.map(m=>products.filter(p=>clean(p.name??"")===clean(m.product_name??"")))
    .filter(p=>p.length===1).map(p=>p[0].id);
   const additional=[...new Set(resolvedIds)].filter(id=>!unlinkedProductIds.includes(id));
   for(const id of additional){
    movements.push(...await all<DatedInventoryCost>((from,to)=>reader.from("inventory_movements")
     .select("id,product_id,created_at,line_total_lyd,unit_cost_lyd")
     .eq("product_id",id).gt("unit_cost_lyd",0)
     .lt("created_at",endNext+"T00:00:00+02:00")
     .order("created_at").order("id").range(from,to)));
   }
  }
  Object.assign(salesByMonth,reconcileInvestorSalesSources({
   months,batches,xyRows,manualSales:manual,movements,products
  }));
 }

 const costPolicies=await reader.from("investor_cost_policies")
  .select("item_type,monthly_amount_lyd,effective_from,effective_through")
  .eq("agreement_id",agreementId).order("effective_from");
 if(costPolicies.error)throw new Error("Owner-approved rent and salary records unavailable.");
 const policies=(costPolicies.data??[]) as DatedCostPolicy[];
 if(from>to)return {audit:auditInvestorFinanceMoneyOut([]),policies,salesByMonth};
 for(let offset=0;offset<25000;offset+=500){
  const result=await reader.from("financial_transactions")
   .select("id,transaction_date,direction,transaction_status,transaction_effect,amount,signed_amount,currency,exchange_rate_usd_to_lyd,category,description,source_type,source_sheet,source_row,review_status,needs_review,is_void,voided_at,transaction_kind,transaction_type,final_bucket,bucket,linked_purchase_id,related_purchase_id")
   .eq("direction","money_out").gte("transaction_date",from).lte("transaction_date",to)
   .order("transaction_date").order("id").range(offset,offset+499);
  if(result.error)throw new Error("Finance money-out register unreadable.");
  const page=(result.data??[]) as InvestorFinanceOutflow[];
  rows.push(...page);
  if(page.length<500)return {audit:auditInvestorFinanceMoneyOut(rows),policies,salesByMonth};
 }
 throw new Error("Finance money-out register exceeded verified audit limit.");
}
