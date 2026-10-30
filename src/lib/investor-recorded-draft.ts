import {
 calculateInvestorOperatingExpenses,
 type InvestorCashOutAudit, type InvestorCostPolicyRow
} from "@/lib/investor-finance-outflow";

export type InvestorMonthlySource = {
 month_start:string;calculation_status:string;
 gross_profit_lyd?:number|string|null;operating_profit_lyd?:number|string|null;
 investor_share_due_lyd?:number|string|null;profit_basis?:string|null;
 capital_purchases_lyd?:number|string|null;source_complete?:boolean|null;
};
export type DatedCostPolicy = InvestorCostPolicyRow & {
 effective_from:string;effective_through?:string|null;
};
export type ReconciledInvestorDraft = InvestorMonthlySource & {
 recordedFinanceMoneyOutLyd?:number|null;
 financeAdjustmentsLyd?:number;
 financeUnreviewedCount?:number;
 financeMirroredImports?:number;
};
const cents=(x:number)=>Math.round((x+Number.EPSILON)*100)/100;
const validMoney=(x:unknown)=>x!=null&&Number.isFinite(Number(x))?cents(Number(x)):null;

/**
 * Pure, read-only recalculation from current recorded Finance/XY snapshots.
 * Draft figures are NOT finalized or payable. They cannot replace a current
 * ledger with a guess when a native USD cash-out rate is unavailable.
 */
export function reconcileRecordedInvestorDrafts({
 statements,sourceAudit,policies,profitShare
}:{statements:InvestorMonthlySource[];sourceAudit:InvestorCashOutAudit;
 policies:DatedCostPolicy[];profitShare:number}):ReconciledInvestorDraft[]{
 const ordered=[...statements].sort((a,b)=>a.month_start.localeCompare(b.month_start));
 let carry=0;
 let priorComplete=true;
 const result:ReconciledInvestorDraft[]=[];
 for(const source of ordered){
  if(source.calculation_status!=="draft"){result.push(source);continue;}
  const period=source.month_start.slice(0,7);
  const summary=sourceAudit.byMonth[period];
  const selectedPolicies=policies.filter(p=>p.effective_from<=source.month_start
    &&(p.effective_through==null||p.effective_through>=source.month_start)
    &&(p.item_type==="rent"||p.item_type==="salary_adjustment"));
  const financeRows=sourceAudit.rows.filter(r=>String(r.transaction_date??"").slice(0,7)===period);
  const expenses=calculateInvestorOperatingExpenses(financeRows,selectedPolicies);
  const gross=validMoney(source.gross_profit_lyd);
  const capex=source.profit_basis==="operating_profit_after_capex"?
    validMoney(source.capital_purchases_lyd):0;
  const verifiable=priorComplete && gross!==null && capex!==null &&
    Number.isFinite(profitShare)&&profitShare>0&&profitShare<=100 &&
    (summary?.missingFxCount??0)===0 && expenses.missingFxOrAmount===0;
  if(!verifiable){
   priorComplete=false;
   result.push({...source,operating_profit_lyd:null,investor_share_due_lyd:null,
    recordedFinanceMoneyOutLyd:summary?.recordedMoneyOutLyd??null,
    financeAdjustmentsLyd:summary?.adjustmentLyd??0,
    financeUnreviewedCount:summary?.reviewedCount??0,
    financeMirroredImports:summary?.duplicateImportCount??0});
   continue;
  }
  const operating=cents(gross-expenses.totalOperatingExpensesLyd);
  const adjusted=cents(operating-(capex??0)+carry);
  carry=Math.min(0,adjusted);
  const share=cents(Math.max(0,adjusted)*profitShare/100);
  result.push({...source,operating_profit_lyd:operating,investor_share_due_lyd:share,
   recordedFinanceMoneyOutLyd:summary?.recordedMoneyOutLyd??0,
   financeAdjustmentsLyd:summary?.adjustmentLyd??0,
   financeUnreviewedCount:summary?.reviewedCount??0,
   financeMirroredImports:summary?.duplicateImportCount??0});
 }
 return result;
}
