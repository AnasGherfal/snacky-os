"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { applyVisibleFinanceLedgerFilter, FINANCE_TRANSACTIONS_TABLE, loadFinanceLedgerRows } from "@/lib/finance-ledger";
import { calculateInvestorMonth, manualRouteSalesAsProfitRows, monthBounds, type InvestorProfitBasis } from "@/lib/investor-profit";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { recordInvestorCommand } from "@/lib/investor-money-actions";

function text(fd: FormData,name: string) { return String(fd.get(name) ?? "").trim(); }
function numberValue(fd: FormData,name: string,fallback=0) { const n=Number(fd.get(name) ?? fallback); return Number.isFinite(n)?n:fallback; }
function optionalNumber(fd: FormData,name: string) { const raw=text(fd,name); return raw?Number(raw):null; }
function investorsUrl(agreementId?: string | null,message?: {type:'success'|'error'|'warning';text:string}) {
 const params=new URLSearchParams(); if(agreementId) params.set('agreement',agreementId); if(message) params.set(message.type,message.text);
 return `/finance/investors${params.size?'?'+params.toString():''}`;
}
async function requireOwnerAdmin() {
 const profile=await getCurrentProfile(); if(!profile || profile.active_status!=='active' || !isOwnerAdminRole(profile)) redirect('/unauthorized');
 const supabase=await getAuthenticatedSupabaseServerClient(); if(!supabase) redirect(investorsUrl(null,{type:'error',text:'Database session unavailable.'}));
 return {profile,supabase};
}

async function loadInvestorVmsProfit(client: any,dateFrom:string,dateTo:string) {
 const monthly=await client.rpc('sales_dashboard_monthly_summary',{p_date_from:dateFrom,p_date_to:dateTo});
 const monthlyRow=(monthly.data ?? [])[0];
 const toRows=(row:any)=>row?[{net_sales_amount:row.revenue_amount,cogs_amount:row.cogs_amount,gross_profit_amount:row.gross_profit_amount,cost_missing:Number(row.missing_cost_sales_count ?? 0)>0,source:'vms'}]:[];
 if(!monthly.error && Number(monthlyRow?.revenue_amount)>0) return {data:toRows(monthlyRow),error:null,source:'monthly_product_profit'};
 const detailed=await client.rpc('sales_dashboard_summary',{p_date_from:dateFrom,p_date_to:dateTo});
 const detailedRow=(detailed.data ?? [])[0];
 if(!detailed.error && Number(detailedRow?.revenue_amount)>0) return {data:toRows(detailedRow),error:null,source:'detailed_sales'};
 // The dashboard RPCs can legitimately return no rows while a verified active
 // XY monthly file exists. Never substitute zero sales or sum superseded uploads.
 const reader=getSupabaseAdminClient() ?? client;
 const active=await reader.from('vms_import_batches').select('id,report_start_date,report_end_date')
  .eq('report_type','monthly_product_profit').eq('is_active',true).eq('status','imported')
  .lte('report_start_date',dateFrom).gte('report_end_date',dateTo);
 if(active.error)return {data:[],error:active.error,source:null};
 if((active.data??[]).length!==1)return {data:[],error:new Error('Exactly one active complete XY monthly profit report is required.'),source:null};
 const batchId=active.data[0].id;
 let all:any[]=[];
 for(let offset=0;offset<10000;offset+=500){
  const result=await reader.from('vms_monthly_product_profit').select('transaction_amount,cost_amount')
   .eq('import_batch_id',batchId).gte('business_month',dateFrom).lte('business_month',dateTo)
   .order('id').range(offset,offset+499);
  if(result.error)return {data:[],error:result.error,source:null};
  all=all.concat(result.data??[]);
  if((result.data??[]).length<500)break;
  if(offset===9500)return {data:[],error:new Error('Active monthly file exceeded safe investor read limit.'),source:null};
 }
 if(!all.length)return {data:[],error:new Error('Active XY monthly report has no profit rows.'),source:null};
 const missing=all.some(row=>row.transaction_amount==null||row.cost_amount==null||
  !Number.isFinite(Number(row.transaction_amount))||!Number.isFinite(Number(row.cost_amount)));
 const revenue=all.reduce((sum,row)=>sum+Number(row.transaction_amount??0),0);
 const cogs=all.reduce((sum,row)=>sum+Number(row.cost_amount??0),0);
 const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
 return {data:[{net_sales_amount:round(revenue),cogs_amount:round(cogs),gross_profit_amount:round(revenue-cogs),cost_missing:missing,source:'vms'}],error:null,source:'active_monthly_product_profit'};
}

async function pagedRows(build:(from:number,to:number)=>any): Promise<{data:any[];error:any}> {
 const rows:any[]=[];
 for(let from=0;from<100000;from+=500) {
  const result=await build(from,from+499); if(result.error) return {data:[],error:result.error};
  rows.push(...(result.data ?? [])); if((result.data ?? []).length<500) return {data:rows,error:null};
 }
 return {data:[],error:new Error('Too many source records to verify safely.')};
}

export async function saveGrowthDecisionSettings(fd:FormData) {
 const {profile,supabase}=await requireOwnerAdmin();
 const {error}=await supabase.from('growth_decision_settings').upsert({
  singleton:true,machine_cost_lyd:Math.max(0,numberValue(fd,'machine_cost_lyd',22000)),minimum_cash_reserve_lyd:Math.max(0,numberValue(fd,'minimum_cash_reserve_lyd',15000)),
  restock_reserve_lyd:Math.max(0,numberValue(fd,'restock_reserve_lyd',10000)),minimum_monthly_operating_profit_lyd:numberValue(fd,'minimum_monthly_operating_profit_lyd',6000),
  target_payback_months:Math.max(1,numberValue(fd,'target_payback_months',18)),minimum_history_months:Math.min(24,Math.max(1,Math.round(numberValue(fd,'minimum_history_months',3)))),updated_by:profile.id,updated_at:new Date().toISOString(),
 },{onConflict:'singleton'});
 if(error) redirect(`/finance/growth-decisions?error=${encodeURIComponent(error.message)}`);
 revalidatePath('/finance/growth-decisions'); redirect('/finance/growth-decisions?success=Decision%20rules%20saved.');
}

export async function createInvestorAgreement(fd:FormData) {
 const {profile,supabase}=await requireOwnerAdmin();
 const login=text(fd,'investor_user_id'),name=text(fd,'investor_name');
 const firstMonth=text(fd,'first_month');
 const startDate=firstMonth?monthBounds(firstMonth)?.start:text(fd,'start_date');
 const endDate=text(fd,'end_date')||null;
 const share=Number(text(fd,'profit_share_percent')),capital=Number(text(fd,'investment_amount_lyd')||0),cap=optionalNumber(fd,'payout_cap_lyd');
 const basis=text(fd,'profit_basis');
 if(!login || !name || !startDate || !/^\d{4}-\d{2}-01$/.test(startDate) || !monthBounds(startDate.slice(0,7)) || (endDate && (Number.isNaN(Date.parse(endDate)) || new Date(endDate).toISOString().slice(0,10)!==endDate || endDate<startDate)) || !Number.isFinite(share) || share<=0 || share>100 || !Number.isFinite(capital) || capital<0 || (cap!==null && (!Number.isFinite(cap)||cap<0)) || !['operating_profit','operating_profit_after_capex'].includes(basis)) {
  redirect(investorsUrl(null,{type:'error',text:'Choose the investor, first profit-sharing month, valid amounts and agreed profit basis.'}));
 }
 const {data:investor,error:profileError}=await supabase.from('profiles').select('id,role,roles,active_status').eq('id',login).maybeSingle();
 if(profileError || !investor || investor.active_status!=='active' || (investor.role!=='investor' && !(investor.roles ?? []).includes('investor'))) redirect(investorsUrl(null,{type:'error',text:'Select an active login with the Investor role.'}));
 const {data,error}=await supabase.from('investor_agreements').insert({investor_user_id:login,investor_name:name,investment_amount_lyd:capital,profit_share_percent:share,profit_basis:basis,profit_basis_confirmed:true,start_date:startDate,end_date:endDate,payout_cap_lyd:cap,status:'active',notes:text(fd,'notes')||null,created_by:profile.id}).select('id').single();
 if(error || !data) redirect(investorsUrl(null,{type:'error',text:error?.code==='23505'?'This investor already has an active agreement. Open it instead.':error?.message ?? 'Could not create agreement.'}));
 revalidatePath('/finance/investors');revalidatePath('/investor');
 redirect(investorsUrl(data.id,{type:'success',text:'Agreement created. Record or link the actual capital receipt separately; no money was posted by creating this agreement.'}));
}

export async function generateInvestorStatement(fd:FormData) {
 const {profile,supabase}=await requireOwnerAdmin();
 const agreementId=text(fd,'agreement_id'),bounds=monthBounds(text(fd,'month'));
 function fail(message:string):never { redirect(investorsUrl(agreementId,{type:'error',text:message})); }
 if(!agreementId || !bounds) fail('Choose a valid agreement and month.');
 const {data:agreement,error:agreementError}=await supabase.from('investor_agreements').select('*').eq('id',agreementId).maybeSingle();
 if(agreementError || !agreement) fail('Investor agreement could not be verified.');
 if(agreement.status!=='active' || !agreement.profit_basis_confirmed) fail('Confirm the profit basis on the active agreement first.');
 if(bounds.start<agreement.start_date || (agreement.end_date && bounds.end>agreement.end_date)) fail('Select a full month within the agreement. No partial-month entitlement is inferred.');
 if(agreement.investment_amount_usd!=null){
  const priorHistory=await supabase.from('investor_historical_months').select('id').eq('investor_user_id',agreement.investor_user_id).eq('month_start',bounds.start).limit(1);
  if(priorHistory.error)fail('Could not check linked historical investor records.');
  if((priorHistory.data??[]).length)fail('This month is already preserved in confirmed historical investor records; do not create a duplicate draft.');
 }

 const {data:existing,error:existingError}=await supabase.from('investor_monthly_statements').select('id,calculation_status').eq('agreement_id',agreementId).eq('month_start',bounds.start).maybeSingle();
 if(existingError) fail('Could not check the existing statement.');
 if(existing?.calculation_status === "finalized") fail('This month is finalized and cannot be recalculated.');
 const operationalReadClient=getSupabaseAdminClient() ?? supabase;
 const nextDay=new Date(Date.parse(`${bounds.end}T12:00:00Z`)+86400000).toISOString().slice(0,10);
 const [salesResult,manualSalesResult,priorStatementsResult]=await Promise.all([
  loadInvestorVmsProfit(supabase,bounds.start,bounds.end),
  pagedRows((from,to)=>operationalReadClient.from('route_manual_sales').select('id,machine_id,total_amount_lyd,inventory_movement_id,sale_time,status').eq('status','confirmed').gte('sale_time',`${bounds.start}T00:00:00+02:00`).lt('sale_time',`${nextDay}T00:00:00+02:00`).order('id').range(from,to)),
  supabase.from('investor_monthly_statements').select('month_start,investor_share_due_lyd,loss_carried_out_lyd,calculation_status,investor_share_due_usd').eq('agreement_id',agreementId).lt('month_start',bounds.start).order('month_start',{ascending:false}),
 ]);
 if(salesResult.error) fail('VMS sales could not load. No zero revenue was assumed.');
 if(manualSalesResult.error) fail('Manual route sales could not load.');
 if(priorStatementsResult.error) fail('Prior investor entitlements could not load.');
 const ledgerRows:any[]=[];
 for(let from=0;from<100000;from+=500) {
  const ledger=await loadFinanceLedgerRows({label:`investor-statement.${bounds.start}.${from}`,buildQuery:(columns,level)=>applyVisibleFinanceLedgerFilter(supabase.from(FINANCE_TRANSACTIONS_TABLE).select(columns.join(',')).gte('transaction_date',bounds.start).lte('transaction_date',bounds.end).order('id').range(from,from+499),level)});
  if(ledger.error || ledger.level!=='full') fail('Complete Finance amounts, currencies, exchange rates and categories must load before calculating investor profit.');
  ledgerRows.push(...ledger.data); if(ledger.data.length<500) break;
  if(from===99500) fail('Finance source exceeded the safe verification limit.');
 }
 const movementIds=Array.from(new Set(manualSalesResult.data.map((row:any)=>String(row.inventory_movement_id??'')).filter(Boolean)));
 const movements:any[]=[];
 for(let offset=0;offset<movementIds.length;offset+=250) {
  const result=await operationalReadClient.from('inventory_movements').select('id,line_total_lyd,unit_cost_lyd').in('id',movementIds.slice(offset,offset+250));
  if(result.error) fail('Manual-sale product costs could not load.'); movements.push(...(result.data??[]));
 }

 // Accrue contractual site rent even when payment and Finance classification are
 // not yet linked. Offset confirmed Finance rent so the same liability is not deducted twice.
 const siteRent=await supabase.from('location_admin_obligations').select('amount_lyd,title,due_date,rent_period_start_month,is_practice')
   .gte('due_date',bounds.start).lte('due_date',bounds.end).or('is_practice.eq.false,is_practice.is.null');
 if(siteRent.error)fail('Location rent obligations could not be verified.');
 const siteRentDue=(siteRent.data??[]).filter((r:any)=>/rent|ايجار|إيجار/i.test(String(r.title??'')))
   .reduce((sum:number,r:any)=>sum+Number(r.amount_lyd??0),0);
 const bookedRent=ledgerRows.filter((row:any)=>row.direction==='money_out'&&row.transaction_effect==='expense'&&row.transaction_status==='active'
   && !row.is_void&&row.voided_at==null&&['confirmed','reviewed'].includes(String(row.review_status??''))
   && String(row.currency??'LYD').toUpperCase()==='LYD'
   && /rent|ايجار|إيجار/i.test(String(row.category??'')+' '+String(row.description??'')))
   .reduce((sum:number,row:any)=>sum+Number(row.amount??0),0);
 const extraRent=Math.round(Math.max(0,siteRentDue-bookedRent)*100)/100;

 const manualProfitRows=manualRouteSalesAsProfitRows(manualSalesResult.data,movements);
 const calculation=calculateInvestorMonth({salesRows:[...salesResult.data,...manualProfitRows],ledgerRows,sharePercent:Number(agreement.profit_share_percent),profitBasis:agreement.profit_basis as InvestorProfitBasis});
 const pendingExpenseRows=ledgerRows.filter(row=>row.direction==='money_out' && row.transaction_status==='active' && !row.is_void && (row.needs_review || row.review_status==='needs_review'));
 const previousStatements=priorStatementsResult.data??[];
 const priorFinalized=previousStatements.filter(row=>row.calculation_status==='finalized');
 const last=previousStatements[0]??null;
 const expectedPriorMonth=new Date(Date.parse(bounds.start+'T12:00:00Z')-86400000).toISOString().slice(0,7);
 const priorMonthKnown=last?.month_start?.slice(0,7)===expectedPriorMonth || bounds.start==='2026-04-01';
 const priorLoss=last && last.month_start?.slice(0,7)===expectedPriorMonth?Number(last.loss_carried_out_lyd??0):0;
 // Profit share is zero while earlier operating losses remain unrecouped.
 const adjustedProfit=Math.round((calculation.distributionBasisLyd-extraRent+priorLoss+Number.EPSILON)*100)/100;
 const carriedLossOut=Math.round(Math.min(0,adjustedProfit)*100)/100;
 const grossShare=Math.round(Math.max(0,adjustedProfit)*Number(agreement.profit_share_percent))/100;
 const cap=agreement.payout_cap_lyd==null?null:Number(agreement.payout_cap_lyd);
 const priorDue=priorFinalized.reduce((sum,row)=>sum+Number(row.investor_share_due_lyd),0);
 let investorDue=cap===null?grossShare:Math.min(grossShare,Math.max(0,cap-priorDue));
 const usdCapped=agreement.payout_cap_usd!=null;
 const requestedRate=Number(text(fd,'usd_rate_lyd_per_usd'));
 const rate=usdCapped&&Number.isFinite(requestedRate)&&requestedRate>0?requestedRate:null;
 const rateSource=text(fd,'usd_rate_source');
 const complete=calculation.complete && pendingExpenseRows.length===0 && priorMonthKnown &&
  (bounds.start==='2026-04-01'||!!last) && previousStatements.every(row=>row.calculation_status==='finalized') &&
  (!usdCapped||(rate!==null&&rateSource.length>=8));
 let shareUsd:number|null=null;
 if(usdCapped&&rate!=null){
  const history=await supabase.from('investor_historical_months').select('confirmed_payable_usd,payment_confirmed_at')
   .eq('investor_user_id',agreement.investor_user_id).gte('month_start',agreement.start_date).lt('month_start',bounds.start);
  if(history.error)fail('Could not verify historical investor entitlement before USD cap calculation.');
  if((history.data??[]).some(h=>h.payment_confirmed_at==null||h.confirmed_payable_usd==null))
   fail('Historical investor entitlement is incomplete.');
  const previouslyDueUsd=(history.data??[]).reduce((sum,h)=>sum+Number(h.confirmed_payable_usd),0)
   +priorFinalized.reduce((sum,row)=>sum+Number(row.investor_share_due_usd??0),0);
  shareUsd=Math.max(0,Math.min(Math.round((grossShare/rate)*100)/100,Number(agreement.payout_cap_usd)-previouslyDueUsd));
  investorDue=Math.min(investorDue,Math.round(shareUsd*rate*100)/100);
 }
 const sourceNote=[`period ${bounds.start} to ${bounds.end}`,`VMS source: ${salesResult.source}`,`manual sales revenue: ${calculation.manualSalesRevenueLyd}`,`manual sales COGS: ${calculation.manualSalesCogsLyd}`,`stock cash-out (not deducted twice): ${calculation.stockPurchasesLyd}`,`unreviewed expenses: ${pendingExpenseRows.length}`,`recorded_site_rent: ${siteRentDue}`,`booked_rent: ${bookedRent}`,`additional_accrued_rent: ${extraRent}`,`complete=${complete}`,`carry_in=${priorLoss}`,`carry_out=${carriedLossOut}`,`rate_USD_LYD=${rate??'not documented'}`,`FX_evidence=${rateSource||'not supplied'}`,`USD_cap=${agreement.payout_cap_usd??'none'}`,...calculation.accountingWarnings].join('; ');
 const {error:saveError}=await supabase.from('investor_monthly_statements').upsert({
  ...(existing?.id?{id:existing.id}:{}),agreement_id:agreementId,month_start:bounds.start,revenue_lyd:calculation.revenueLyd,cogs_lyd:calculation.cogsLyd,gross_profit_lyd:calculation.grossProfitLyd,
  operating_expenses_lyd:Math.round((calculation.operatingExpensesLyd+extraRent)*100)/100,operating_profit_lyd:Math.round((calculation.operatingProfitLyd-extraRent)*100)/100,capital_purchases_lyd:calculation.capitalPurchasesLyd,
  distribution_basis_lyd:Math.max(0,adjustedProfit),loss_carried_in_lyd:priorLoss,loss_carried_out_lyd:carriedLossOut,usd_rate_lyd_per_usd:rate,investor_share_due_usd:shareUsd,profit_basis:calculation.profitBasis,expense_breakdown:[...calculation.expenseBreakdown,...(extraRent>0?[{key:'accrued_site_rent',label:'Site rent accrued from obligations, after confirmed Finance rent offset',amount:extraRent,transactionCount:(siteRent.data??[]).length}]:[])],source_complete:complete,review_checks:null,
  share_percent:calculation.sharePercent,investor_share_due_lyd:investorDue,calculation_status:'draft',data_source_note:sourceNote,generated_by:profile.id,generated_at:new Date().toISOString(),finalized_at:null,updated_at:new Date().toISOString(),
 },{onConflict:'agreement_id,month_start'});
 if(saveError) fail(saveError.message);
 revalidatePath('/finance/investors');revalidatePath('/investor');
 redirect(investorsUrl(agreementId,{type:complete?'success':'warning',text:complete?'Monthly draft ready. Review rent/payroll, all expenses, sales completeness and machine purchases before finalizing.':'Draft is incomplete. Resolve sales costs, unreviewed expenses or missing USD rates, then recalculate. No entitlement was finalized.'}));
}

export async function finalizeInvestorStatement(fd:FormData) {
 const {supabase}=await requireOwnerAdmin();
 const agreementId=text(fd,'agreement_id'),statementId=text(fd,'statement_id');
 const checks=Object.fromEntries(['sales','rent_payroll','expenses','capital'].map(key=>[key,text(fd,`review_${key}`)==='yes']));
 const {error}=await supabase.rpc('snacky_finalize_investor_statement_v1',{p_statement_id:statementId,p_generated_at:text(fd,'generated_at'),p_review_checks:checks});
 if(error) redirect(investorsUrl(agreementId,{type:'error',text:error.message}));
 revalidatePath('/finance/investors');revalidatePath('/investor');
 redirect(investorsUrl(agreementId,{type:'success',text:'Monthly entitlement finalized. It remains unpaid until an actual payout is recorded.'}));
}

/** Compatibility entry point. New forms use the same atomic command directly. */
export async function recordInvestorPayment(fd:FormData) {
 fd.set('kind','payout');fd.set('entity_id',text(fd,'statement_id'));fd.set('amount',text(fd,'amount_lyd'));fd.set('date',text(fd,'payment_date'));fd.set('account',text(fd,'account_id')||'snacky_lyd');fd.set('method',text(fd,'payment_method')||'cash');fd.set('reference',text(fd,'payment_reference'));fd.set('confirm','yes');
 const result=await recordInvestorCommand(fd);
 redirect(investorsUrl(text(fd,'agreement_id'),{type:result.ok?'success':'error',text:result.message}));
}
