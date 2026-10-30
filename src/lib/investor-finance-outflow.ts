import { canonicalExpenseCategory,isFinanceProductPurchaseRow } from "./finance-operations";
import { isInvestorCapitalPurchase } from "./investor-expenses";
/**
 * Finance money-out evidence for investor reconciliation. Every active, non-void
 * money_out is counted regardless of its category or description (including
 * Arabic budget adjustments). Currency conversion requires the transaction's
 * own recorded FX rate: no guessed value is permitted.
 *
 * Two imports of the same CSV source line are a single underlying cash event.
 * Only exact bootstrap/CSV counterparts are suppressed, with the number and
 * value of mirrored entries retained in the audit result.
 *
 * IMPORTANT: This is a cash-out register, not an assertion that buying stock,
 * exchanging currencies or transferring between accounts is an operating
 * expense. Contractual operating profit already includes COGS and accrued rent;
 * subtracting such cash movements a second time would misstate profits.
 */
export type InvestorFinanceOutflow = {
 id?: string | null; transaction_date?: string | null; direction?: string | null;
 transaction_status?: string | null; transaction_effect?: string | null;
 amount?: number | string | null; signed_amount?: number | string | null;
 currency?: string | null; exchange_rate_usd_to_lyd?: number | string | null;
 category?: string | null; description?: string | null; source_type?: string | null;
 transaction_kind?:string|null;transaction_type?:string|null;final_bucket?:string|null;bucket?:string|null;
 linked_purchase_id?:string|null;related_purchase_id?:string|null;
 source_sheet?: string | null; source_row?: number | string | null;
 review_status?: string | null; needs_review?: boolean | null;
 is_void?: boolean | null; voided_at?: string | null;
};
export type InvestorCashOutMonth = {
 period: string; recordedMoneyOutLyd: number | null;
 knownMoneyOutLyd: number; reviewedCount: number; actualRowCount: number;
 duplicateImportCount: number; duplicateImportLyd: number;
 missingFxCount: number; missingFxNativeUsd: number;
 transferLyd: number; adjustmentLyd: number;
};
export type InvestorCashOutAudit = {
 rows: InvestorFinanceOutflow[];
 byMonth: Record<string, InvestorCashOutMonth>;
 duplicateImportCount: number;
 missingFxCount: number;
 auditIssues: string[];
};
const round=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const amount=(r:InvestorFinanceOutflow)=>{
 if(r.amount==null && r.signed_amount==null)return null;
 const a=Number(r.amount??r.signed_amount);
 return Number.isFinite(a)&&a>=0?round(a):null;
};
const normal=(x:unknown)=>String(x??"").trim().toLowerCase();
function signature(r:InvestorFinanceOutflow){
 if(r.source_row==null||!r.transaction_date)return null;
 const num=amount(r);if(num===null)return null;
 return [r.transaction_date.slice(0,10),r.source_row,normal(r.currency||"LYD"),num.toFixed(2)].join("|");
}
const active=(r:InvestorFinanceOutflow)=>
 r.direction==="money_out" && r.transaction_status==="active" && !r.is_void && !r.voided_at;

export function auditInvestorFinanceMoneyOut(sourceRows:InvestorFinanceOutflow[]):InvestorCashOutAudit{
 const valid=sourceRows.filter(active);
 const csvSignatures=new Set(valid.filter(r=>r.source_sheet==="financial_transactions.csv").map(signature).filter(Boolean));
 const rows:InvestorFinanceOutflow[]=[];
 const byMonth:Record<string,InvestorCashOutMonth>={};
 const issues:string[]=[];
 const seenIds=new Set<string>();
 let duplicateImportCount=0,missingFxCount=0;
 function monthFor(row:InvestorFinanceOutflow) {
  const period=String(row.transaction_date??"").slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return null;
  if(!byMonth[period])byMonth[period]={period,recordedMoneyOutLyd:0,knownMoneyOutLyd:0,
   reviewedCount:0,actualRowCount:0,duplicateImportCount:0,duplicateImportLyd:0,
   missingFxCount:0,missingFxNativeUsd:0,transferLyd:0,adjustmentLyd:0};
  return byMonth[period];
 }
 for(const r of valid){
  if(r.id&&seenIds.has(r.id)){issues.push("Finance ID duplicated in paged results");continue;}
  if(r.id)seenIds.add(r.id);
  const month=monthFor(r);if(!month){issues.push("Missing valid Finance transaction date");continue;}
  const val=amount(r),sig=signature(r);
  const mirrored=r.source_sheet==="production_bootstrap_financial_transactions" && sig!==null && csvSignatures.has(sig);
  if(mirrored){
   duplicateImportCount++;month.duplicateImportCount++;
   if(val!==null)month.duplicateImportLyd=round(month.duplicateImportLyd+val);
   continue;
  }
  rows.push(r);month.actualRowCount++;
  if(r.review_status==="needs_review"||r.needs_review)month.reviewedCount++;
  const currency=normal(r.currency||"LYD");
  const rate=currency==="LYD"?1:Number(r.exchange_rate_usd_to_lyd??NaN);
  if(val===null||!Number.isFinite(rate)||rate<=0){
   month.recordedMoneyOutLyd=null;month.missingFxCount++;missingFxCount++;
   if(currency==="USD"&&val!==null)month.missingFxNativeUsd=round(month.missingFxNativeUsd+val);
   issues.push("One or more Finance debits have missing amount, currency or documented FX rate");
   continue;
  }
  if(currency!=="LYD"&&currency!=="USD"){
   month.recordedMoneyOutLyd=null;month.missingFxCount++;missingFxCount++;
   issues.push("Unknown Finance currency");continue;
  }
  const converted=round(val*rate);
  month.knownMoneyOutLyd=round(month.knownMoneyOutLyd+converted);
  if(month.recordedMoneyOutLyd!==null)month.recordedMoneyOutLyd=month.knownMoneyOutLyd;
  if(r.transaction_effect==="transfer")month.transferLyd=round(month.transferLyd+converted);
  const desc=normal(r.description);
  if(/تعديل\s*الميزاني[هة]/u.test(desc))month.adjustmentLyd=round(month.adjustmentLyd+converted);
 }
 return {rows,byMonth,duplicateImportCount,missingFxCount,auditIssues:[...new Set(issues)]};
}


export type InvestorCostPolicyRow = {
 item_key?:string; item_type?:string;label?:string;
 monthly_amount_lyd?:number|string|null;
};
export type InvestorOperatingExpenseAudit = {
 additionalCashOperatingLyd:number;
 accruedPolicyLyd:number;
 totalOperatingExpensesLyd:number;
 includedOutCount:number;
 excludedProductCount:number;
 excludedCapitalCount:number;
 excludedRentPaidCount:number;
 excludedTransferCount:number;
 missingFxOrAmount:number;
 warnings:string[];
};

/**
 * Count all actual money-out in the cash register; deduct it once according to
 * the signed operating-profit basis. Inventory buying is represented by COGS,
 * real machine capital and transfers are separately recorded cash movement,
 * and rent already accrued in an owner-confirmed policy is not deducted twice.
 * Every other outgoing expense (even Uncategorized, Other, Charity, adjustment)
 * is included without a text-based owner/charity/budget exemption.
 */
export function calculateInvestorOperatingExpenses(
 sourceRows:InvestorFinanceOutflow[],
 policyRows:InvestorCostPolicyRow[],
):InvestorOperatingExpenseAudit {
 let extra=0,accrual=0,includedOutCount=0,excludedProductCount=0,excludedCapitalCount=0,
 excludedRentPaidCount=0,excludedTransferCount=0,missingFxOrAmount=0;
 const warnings:string[]=[];
 const policyRent=policyRows.some(p=>p.item_type==="rent");
 for(const policy of policyRows){
  if(!["rent","salary_adjustment"].includes(policy.item_type??""))continue;
  const value=Number(policy.monthly_amount_lyd);
  if(!Number.isFinite(value)||value<0){warnings.push("Invalid recorded investor cost policy");missingFxOrAmount++;continue;}
  accrual=round(accrual+value);
 }
 for(const row of sourceRows){
  if(!active(row))continue;
  if(row.transaction_effect==="transfer"||row.transaction_effect==="opening_balance"){excludedTransferCount++;continue;}
  const meta=[row.source_type,row.category,row.transaction_type,row.final_bucket,row.bucket,row.description].map(normal).join(" | ");
  if(/investor profit share|investor distribution|capital return|investor_payment/.test(meta))continue;
  const canonical=canonicalExpenseCategory(row);
  if(isFinanceProductPurchaseRow(row)||row.source_type==="purchase_payment"||row.transaction_kind==="product_purchase"){
   excludedProductCount++;continue;
  }
  if(isInvestorCapitalPurchase(row)){excludedCapitalCount++;continue;}
  const desc=normal(row.description);
  if(policyRent && (canonical.key==="rent"||/ايجار|إيجار|مخزن|warehouse/.test(desc))){
   excludedRentPaidCount++;continue;
  }
  const val=amount(row),currency=normal(row.currency||"LYD");
  const fx=currency==="LYD"?1:currency==="USD"?Number(row.exchange_rate_usd_to_lyd??NaN):NaN;
  if(val===null||!Number.isFinite(fx)||fx<=0){
   missingFxOrAmount++;warnings.push("Recorded expense lacks amount or documented currency rate");continue;
  }
  extra=round(extra+round(val*fx));includedOutCount++;
 }
 return {additionalCashOperatingLyd:extra,accruedPolicyLyd:accrual,
  totalOperatingExpensesLyd:round(extra+accrual),includedOutCount,excludedProductCount,
  excludedCapitalCount,excludedRentPaidCount,excludedTransferCount,
  missingFxOrAmount,warnings:[...new Set(warnings)]};
}
