"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";

export type InvestorMoneyResult = { ok: boolean; message: string; resetAllowed?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (fd: FormData,key: string) => String(fd.get(key) ?? "").trim();

export async function recordInvestorCommand(fd: FormData): Promise<InvestorMoneyResult> {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) return {ok:false,message:"Only an active owner/admin can record investor money."};
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return {ok:false,message:"Session unavailable. Retry the same saved request after signing in."};
  const kind = text(fd,"kind"), command = text(fd,"client_submission_id"), entity = text(fd,"entity_id");
  const amount = Number(text(fd,"amount")), date = text(fd,"date"), account = text(fd,"account"), method = text(fd,"method") || "cash";
  const reference = text(fd,"reference"), notes = text(fd,"notes");
  const fail = (message: string,resetAllowed=false): InvestorMoneyResult => ({ok:false,message,resetAllowed});
  if (!['payout','contribution'].includes(kind) || !uuid.test(command) || !uuid.test(entity)) return fail("Invalid investor or request identity. Reload before recording money.");
  if (text(fd,"confirm")!=="yes") return fail("Confirm that this money has actually been received or paid.",true);
  if (!Number.isFinite(amount) || amount<=0 || amount>=1e10 || Math.abs(amount*100-Math.round(amount*100))>1e-6) return fail("Enter a positive amount with at most two decimal places.",true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) return fail("Enter a valid actual payment date.",true);
  if (reference.length>200 || notes.length>2000) return fail("Reference or note is too long.",true);
  const currency = kind==='payout' ? 'LYD' : text(fd,"currency");
  const rate = currency==='LYD' ? 1 : Number(text(fd,"rate"));
  const existing = text(fd,"existing_finance_id");
  if (kind==='contribution' && (!['new','link'].includes(text(fd,"funding_mode")) || (text(fd,"funding_mode")==='link' && !uuid.test(existing)))) return fail("Choose an existing Finance receipt, or explicitly choose to record a new cash-in.",true);
  if (!['LYD','USD'].includes(currency) || !Number.isFinite(rate) || rate<=0 || rate>=1e6 || !['snacky_lyd','snacky_usd','owner_lyd','owner_usd'].includes(account) || !account.endsWith(currency.toLowerCase())) return fail("Choose a matching currency/account and a positive historical LYD exchange rate.",true);
  try {
    const result = kind==='payout'
      ? await db.rpc("snacky_record_investor_payment_v1", {p_statement_id:entity,p_amount:amount,p_payment_date:date,p_account_id:account,p_method:method,p_reference:reference,p_notes:notes,p_command_id:command})
      : await db.rpc("snacky_record_investor_contribution_v1", {p_agreement_id:entity,p_amount:amount,p_currency:currency,p_rate:rate,p_received_date:date,p_account_id:account,p_reference:reference,p_notes:notes,p_existing_finance_id:text(fd,"funding_mode")==='link'?existing:null,p_command_id:command});
    if (result.error) {
      console.error('[investor-money] Atomic command failed',{kind,entity,error:result.error});
      const code=String(result.error.code ?? '');
      const knownRollback=/^(22|23)/.test(code) || ['P0001','42501','28000'].includes(code);
      return fail(knownRollback ? result.error.message : "The money result could not be confirmed. Retry this same saved request, not a new payment.",knownRollback);
    }
    const receipt=result.data as Record<string,unknown> | null;
    if (!receipt || receipt.client_submission_id!==command || !receipt.finance_transaction_id || (kind==='payout'?receipt.statement_id:receipt.agreement_id)!==entity) return fail("Unexpected money receipt. Keep this request and check the investor history.");
    const {data:finance,error}=await db.from('financial_transactions').select('id,amount,signed_amount,currency,account_id,transaction_status,is_void,voided_at').eq('id',String(receipt.finance_transaction_id)).maybeSingle();
    if (error || !finance || finance.transaction_status!=='active' || finance.is_void || finance.voided_at || Number(finance.amount)!==amount || Number(finance.signed_amount)!==(kind==='payout'?-amount:amount) || finance.currency!==currency || finance.account_id!==account) return fail("The investor record exists but its Finance entry could not be verified. Retry this same saved request; do not record it again.");
    try { await logActivity({profile,action:kind==='payout'?'investor_payout':'investor_contribution',entityType:'investor_agreement',entityId:String(receipt.agreement_id),afterData:receipt,idempotencyKey:`investor-money:${command}`,summary:kind==='payout'?'Recorded investor profit distribution and matching cash-out':'Recorded investor capital separately from profit'}); } catch (error) { console.error('[investor-money] Audit follow-up needed',error); }
    for(const path of ['/finance/investors','/investor','/finance','/finance/transactions','/finance/operations']) revalidatePath(path);
    return {ok:true,message:kind==='payout'?'Investor payout recorded; Finance and the monthly unpaid balance were updated.':'Capital receipt recorded and linked to Finance. This is not sales or profit.'};
  } catch (error) {
    console.error('[investor-money] Uncertain command response',{kind,entity,error});
    return fail("The result could not be confirmed. Retry the same saved request to avoid recording the money twice.");
  }
}
