/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChartCard, TrendChart } from "@/components/DecisionCharts";
import { InvestorMoneyForm, type InvestorFundingReceipt } from "@/components/InvestorMoneyForm";
import { InvestorStatementCard, type InvestorStatementRecord } from "@/components/InvestorStatementCard";
import { EmptyState, ErrorState, FormField, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { formatFinanceMoney } from "@/lib/finance-balance";
import { createInvestorAgreement, generateInvestorStatement } from "@/lib/investor-actions";
import { updateInvestorAgreement } from "@/lib/investor-agreement-actions";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
async function allRows(build:(from:number,to:number)=>any):Promise<any[]> {
 const rows:any[]=[];
 for(let from=0;from<50000;from+=500) {
  const result=await build(from,from+499);if(result.error)throw result.error;
  rows.push(...(result.data??[]));if((result.data??[]).length<500)return rows;
 }
 throw new Error('Too many records to verify safely.');
}
function previousMonthValue() {
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit'}).formatToParts(new Date());
 return new Date(Date.UTC(Number(parts.find(p=>p.type==='year')?.value),Number(parts.find(p=>p.type==='month')?.value)-2,1)).toISOString().slice(0,7);
}
function BasisOptions({ar}:{ar:boolean}) {return <><option value="">{ar?'اختر أساس الربح المتفق عليه':'Choose the agreed profit basis'}</option><option value="operating_profit">{ar?'الربح التشغيلي — الماكينات منفصلة':'Operating profit — machines shown separately'}</option><option value="operating_profit_after_capex">{ar?'الربح التشغيلي ناقص مشتريات الماكينات':'Operating profit less machine purchases'}</option></>;}

export default async function InvestorsPage({searchParams}:{searchParams:Promise<{agreement?:string;success?:string;error?:string;warning?:string}>}) {
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!isOwnerAdminRole(profile))redirect('/unauthorized');
 const db=await getAuthenticatedSupabaseServerClient(),{locale}=await getServerI18n(),ar=locale==='ar',params=await searchParams;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const unavailable=()=> <ErrorState title={tr('Investor data unavailable','بيانات المستثمر غير متاحة')} body={tr('Could not verify the investor records. No zero capital, profit or unpaid balance has been assumed. Reload after the connection/schema is restored.','تعذر التحقق من سجلات المستثمر. لم تُفترض أرصدة أو أرباح صفرية. أعد التحميل بعد استعادة الاتصال أو تحديث قاعدة البيانات.')} />;
 if(!db)return unavailable();
 let agreements:any[],profiles:any[],statements:InvestorStatementRecord[]=[],payments:any[]=[],contributions:any[]=[],receipts:InvestorFundingReceipt[]=[];
 try {
  [agreements,profiles]=await Promise.all([
   allRows((from,to)=>db.from('investor_agreements').select('*').order('start_date',{ascending:false}).order('id').range(from,to)),
   allRows((from,to)=>db.from('profiles').select('id,full_name,email,role,roles,active_status').eq('active_status','active').order('id').range(from,to)),
  ]);
 }catch(error){console.error('[investors] Failed to load agreements/profiles',error);return unavailable();}
 const selected=agreements.find(a=>a.id===params.agreement)??agreements[0]??null;
 const investorProfiles=profiles.filter(p=>p.role==='investor'||(p.roles??[]).includes('investor'));
 let receiptLookupError=false;
 if(selected) {
  try {
   [statements,payments,contributions]=await Promise.all([
    allRows((from,to)=>db.from('investor_monthly_statements').select('*').eq('agreement_id',selected.id).order('month_start',{ascending:false}).order('id').range(from,to)),
    allRows((from,to)=>db.from('investor_payments').select('*').eq('agreement_id',selected.id).order('payment_date',{ascending:false}).order('id').range(from,to)),
    allRows((from,to)=>db.from('investor_contributions').select('*').eq('agreement_id',selected.id).order('received_date',{ascending:false}).order('id').range(from,to)),
   ]);
   const finance=await db.from('financial_transactions').select('id,transaction_date,description,amount,currency,account_id,exchange_rate_usd_to_lyd').eq('direction','money_in').eq('transaction_status','active').eq('transaction_effect','income').in('transaction_kind',['manual_money_in','spreadsheet_import']).in('review_status',['confirmed','reviewed']).or('is_void.eq.false,is_void.is.null').is('voided_at',null).order('transaction_date',{ascending:false}).order('id').limit(200);
   receiptLookupError=Boolean(finance.error);
   const linked=new Set(contributions.map(c=>c.finance_transaction_id));
   receipts=((finance.data??[]) as InvestorFundingReceipt[]).filter(r=>!linked.has(r.id));
  }catch(error){console.error('[investors] Failed to load investor history',error);return unavailable();}
 }
 const finalized=statements.filter(s=>s.calculation_status==='finalized');
 const posted=payments.filter(p=>p.finance_posting_status==='posted'&&p.finance_transaction_id);
 const unresolvedPayments=payments.length!==posted.length;
 const totalDue=finalized.reduce((sum,s)=>sum+Number(s.investor_share_due_lyd),0),totalPaid=posted.reduce((sum,p)=>sum+Number(p.amount_lyd),0);
 const capitalReceived=contributions.reduce((sum,c)=>sum+Number(c.amount_lyd),0);
 const paidByMonth=new Map<string,number>();posted.forEach(p=>paidByMonth.set(p.statement_id,(paidByMonth.get(p.statement_id)??0)+Number(p.amount_lyd)));
 const locked=finalized.length>0,notice=params.error??params.warning??params.success,chart=[...finalized].reverse();
 return <>
  <PageHeader title={tr('Investors','المستثمرون')} subtitle={tr('Capital received → monthly profit review → agreed share → payouts and unpaid balances.','رأس المال المستلم ← مراجعة الربح الشهري ← النسبة المتفق عليها ← الدفعات والمستحقات.')} action={<Link href="/team/new" className="btn-secondary">{tr('Create investor login','إنشاء دخول مستثمر')}</Link>} />
  <div className="space-y-5">
   {notice?<p role="status" className={`rounded-lg border p-4 text-sm ${params.error?'border-rose-200 bg-rose-50 text-rose-900':params.warning?'border-amber-200 bg-amber-50 text-amber-950':'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice}</p>:null}
   <nav aria-label={tr('Investor agreements','اتفاقيات المستثمرين')} className="flex flex-wrap gap-2">{agreements.map(a=><Link className={selected?.id===a.id?'btn-primary':'btn-secondary'} key={a.id} href={`/finance/investors?agreement=${a.id}`}>{a.investor_name} · {a.profit_share_percent}%</Link>)}</nav>
   <details className="surface-card" open={!selected}>
    <summary className="cursor-pointer font-semibold">{tr('Set up investor agreement','إعداد اتفاقية مستثمر')}</summary>
    <p className="my-3 text-sm text-slate-600">{tr('Choose the first full profit-sharing month and the agreed treatment of new machines. Creating an agreement does not record capital as received or create a Finance transaction.','اختر أول شهر كامل لتقاسم الربح وطريقة معالجة الماكينات الجديدة المتفق عليها. إنشاء الاتفاقية لا يسجل استلام رأس المال ولا ينشئ حركة مالية.')}</p>
    <form action={createInvestorAgreement} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
     <FormField label={tr('Investor login','حساب المستثمر')} required><select name="investor_user_id" className="field-input" defaultValue="" required><option value="">{tr('Choose investor','اختر المستثمر')}</option>{investorProfiles.map(p=><option key={p.id} value={p.id}>{p.full_name}</option>)}</select></FormField>
     <FormField label={tr('Investor name','اسم المستثمر')} required><input name="investor_name" className="field-input" required/></FormField>
     <FormField label={tr('First profit-sharing month','أول شهر لتقاسم الربح')} required><input name="first_month" type="month" className="field-input" required/></FormField>
     <FormField label={tr('Profit share %','نسبة الربح %')} required><input name="profit_share_percent" type="number" min="0.01" max="100" step="0.01" defaultValue="30" className="field-input" required/></FormField>
     <FormField label={tr('Agreed capital — LYD equivalent (optional)','رأس المال المتفق عليه — قيمة بالدينار (اختياري)')}><input name="investment_amount_lyd" type="number" min="0" step="0.01" className="field-input"/></FormField>
     <FormField label={tr('Profit basis — confirm the agreement','أساس الربح — حسب الاتفاق')} required><select name="profit_basis" className="field-input" defaultValue="" required><BasisOptions ar={ar}/></select></FormField>
     <FormField label={tr('End date (optional)','تاريخ النهاية (اختياري)')}><input name="end_date" type="date" className="field-input"/></FormField>
     <FormField label={tr('Total payout cap (optional; blank means no cap)','سقف إجمالي التوزيعات (اختياري؛ فارغ يعني بلا سقف)')}><input name="payout_cap_lyd" type="number" min="0" step="0.01" className="field-input"/></FormField>
     <FormField label={tr('Agreement notes','ملاحظات الاتفاق')}><textarea name="notes" className="field-input" rows={2}/></FormField>
     <button className="btn-primary" disabled={!investorProfiles.length}>{tr('Create agreement','إنشاء الاتفاقية')}</button>
    </form>
   </details>
   {!selected?<EmptyState title={tr('Link an investor agreement first','اربط اتفاقية المستثمر أولاً')} body={tr('An Investor role alone does not create a capital contribution or monthly entitlement. Enter the agreed terms above, then record the actual capital receipt.','دور المستثمر وحده لا ينشئ رأس مال أو مستحقات شهرية. سجّل شروط الاتفاق أعلاه ثم حركة استلام رأس المال الفعلية.')}/>:<>
    <section className="surface-card"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{selected.investor_name} · {selected.profit_share_percent}%</h2><p className="mt-1 text-sm text-slate-600">{selected.start_date} · <StatusBadge status={selected.status}/></p></div><Link href={`/investor?agreement=${selected.id}`} className="btn-secondary">{tr('Preview investor portal','معاينة بوابة المستثمر')}</Link></div><p className="mt-3 text-sm text-slate-600">{tr('Capital is separate from profit. Paid distributions do not reduce next month’s profit. Stock purchases are not deducted again after cost of products sold.','رأس المال منفصل عن الربح. توزيعات الأرباح لا تخفض ربح الشهر التالي. لا تُخصم مشتريات المخزون مرة ثانية بعد تكلفة المنتجات المباعة.')}</p></section>
    {unresolvedPayments?<p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-950">{tr('Some older payouts have unverified Finance postings. They are not shown as settled; resolve them before recording further payouts.','توجد دفعات قديمة لم يتم التحقق من ترحيلها للمالية. لا تظهر كدفعات مسوّاة؛ عالجها قبل تسجيل دفعات أخرى.')}</p>:null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[[tr('Agreed capital','رأس المال المتفق عليه'),selected.investment_amount_lyd],[tr('Capital receipts linked','رأس المال المسجّل استلامه'),capitalReceived],[tr('Finalized due','المستحق المعتمد'),totalDue],[tr('Posted payouts','الدفعات المرحلة'),totalPaid],[tr('Unpaid entitlement','المستحق غير المدفوع'),Math.max(0,totalDue-totalPaid)]].map(([label,value])=><div className="surface-card" key={String(label)}><div className="text-xs text-slate-600">{String(label)}</div><div className="mt-2 text-xl font-semibold">{formatFinanceMoney(Number(value))}</div></div>)}</div>
    <details className="surface-card"><summary className="cursor-pointer font-semibold">{tr('Record or link capital received','تسجيل أو ربط رأس المال المستلم')}</summary><div className="mt-4">{receiptLookupError?<p role="alert">{tr('Existing Finance receipts could not load. Reload before recording capital so an existing receipt is not duplicated.','تعذر تحميل حركات القبض الموجودة. أعد التحميل قبل تسجيل رأس المال لتجنب تكراره.')}</p>:<InvestorMoneyForm key={selected.id} kind="contribution" entityId={selected.id} userId={profile.id} receipts={receipts}/>}</div><p className="mt-3 text-xs text-slate-500">{tr('The link selector shows the latest 200 eligible money-in receipts. Verify older records in Finance before adding capital here.','تعرض قائمة الربط آخر 200 حركة قبض مؤهلة. تحقق من الحركات الأقدم في المالية قبل إضافة رأس المال هنا.')}</p></details>
    <section className="surface-card"><h3 className="font-semibold">{tr('Capital receipt history','سجل استلام رأس المال')}</h3>{!contributions.length?<p className="mt-3 text-sm text-slate-600">{tr('No capital receipt is linked yet. The agreed investment amount is not proof of money received.','لم تُربط حركة استلام رأس مال بعد. قيمة الاستثمار في الاتفاق ليست إثباتاً لاستلام المبلغ.')}</p>:contributions.map(c=><div key={c.id} className="mt-3 flex flex-wrap justify-between gap-3 border-t border-slate-100 pt-3 text-sm"><span>{c.received_date} · {Number(c.original_amount).toFixed(2)} {c.currency} · {tr('LYD value','القيمة بالدينار')}: {formatFinanceMoney(Number(c.amount_lyd))}</span><Link className="link-secondary" href={`/finance/transactions/${c.finance_transaction_id}`}>{tr('Finance receipt','الحركة المالية')}</Link></div>)}</section>
    <ChartCard title={tr('Monthly profit, due and payouts','الربح والمستحق والمدفوع شهرياً')} subtitle={tr('Finalized months only. Expand a month below for its expense breakdown and machine spending.','الأشهر المعتمدة فقط. افتح الشهر أدناه للاطلاع على المصاريف ومشتريات الماكينات.')}><TrendChart labels={chart.map(s=>s.month_start.slice(0,7))} series={[{key:'profit',label:tr('Operating profit','الربح التشغيلي'),values:chart.map(s=>Number(s.operating_profit_lyd))},{key:'due',label:tr('Investor due','مستحق المستثمر'),values:chart.map(s=>Number(s.investor_share_due_lyd))},{key:'paid',label:tr('Paid','المدفوع'),values:chart.map(s=>paidByMonth.get(s.id)??0)}]} valueFormatter={value=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(value)}/></ChartCard>
    <section className="surface-card"><h3 className="font-semibold">{tr('Monthly profit review','مراجعة الربح الشهري')}</h3><p className="my-3 text-sm text-slate-600">{tr('Drafts use recorded sales, product costs and Finance expenses. Missing rent/payroll, depreciation or other obligations are not automatically invented. Review completeness before finalizing. Calculating or finalizing does not move money.','تعتمد المسودات على المبيعات وتكاليف المنتجات ومصاريف المالية المسجّلة. لا تُفترض الإيجارات أو الرواتب أو الإهلاك أو الالتزامات المفقودة تلقائياً. راجع اكتمالها قبل الاعتماد. الحساب والاعتماد لا يحرّكان الأموال.')}</p><form action={generateInvestorStatement} className="flex flex-wrap items-end gap-3"><input type="hidden" name="agreement_id" value={selected.id}/><FormField label={tr('Month','الشهر')}><input name="month" type="month" className="field-input" defaultValue={previousMonthValue()} required/></FormField><button className="btn-primary" disabled={!selected.profit_basis_confirmed||selected.status!=='active'}>{tr('Calculate / refresh draft','حساب أو تحديث مسودة')}</button></form>{!selected.profit_basis_confirmed?<p className="mt-3 text-sm text-amber-900">{tr('Confirm the profit basis in Agreement settings first.','أكد أساس الربح في إعدادات الاتفاق أولاً.')}</p>:null}</section>
    <div className="space-y-3">{statements.map(s=><InvestorStatementCard key={s.id} statement={s} paid={paidByMonth.get(s.id)??0} ar={ar} adminUserId={profile.id}/>)}{!statements.length?<p className="surface-card text-sm">{tr('No monthly statements yet. Calculate the first completed month above.','لا توجد بيانات شهرية بعد. احسب أول شهر مكتمل أعلاه.')}</p>:null}</div>
    <section className="surface-card"><h3 className="font-semibold">{tr('Payout history','سجل توزيعات الأرباح')}</h3>{payments.map(p=><div className="mt-3 flex flex-wrap justify-between gap-3 border-t border-slate-100 pt-3 text-sm" key={p.id}><span>{p.payment_date} · {formatFinanceMoney(Number(p.amount_lyd))} · {statements.find(s=>s.id===p.statement_id)?.month_start.slice(0,7)??tr('Unallocated','غير مخصص')}</span><StatusBadge status={p.finance_posting_status}/>{p.finance_transaction_id?<Link className="link-secondary" href={`/finance/transactions/${p.finance_transaction_id}`}>{tr('Finance entry','الحركة المالية')}</Link>:null}</div>)}{!payments.length?<p className="mt-3 text-sm text-slate-500">{tr('No payouts recorded.','لا توجد توزيعات مسجّلة.')}</p>:null}</section>
    <details className="surface-card"><summary className="cursor-pointer font-semibold">{tr('Agreement settings','إعدادات الاتفاق')}</summary><p className="my-3 text-sm text-slate-600">{locked?tr('Financial terms are locked after the first finalized month; historical entitlements cannot be rewritten.','تُقفل الشروط المالية بعد اعتماد أول شهر؛ لا يمكن إعادة كتابة المستحقات السابقة.'):tr('Confirm the actual agreement, not an assumed accounting rule.','أكد شروط الاتفاق الفعلية وليس قاعدة محاسبية مفترضة.')}</p><form action={updateInvestorAgreement} className="grid gap-3 md:grid-cols-2"><input type="hidden" name="agreement_id" value={selected.id}/><FormField label={tr('Name','الاسم')}><input className="field-input" name="investor_name" defaultValue={selected.investor_name} required/></FormField><FormField label={tr('Agreed capital (LYD)','رأس المال المتفق عليه (د.ل)')}><input className="field-input" name="investment_amount_lyd" type="number" step="0.01" min="0" defaultValue={selected.investment_amount_lyd}/></FormField><FormField label={tr('Share %','النسبة %')}><input className="field-input" name="profit_share_percent" type="number" step="0.01" min="0.01" max="100" defaultValue={selected.profit_share_percent} readOnly={locked} required/></FormField><FormField label={tr('Start date — first of month','تاريخ البداية — أول الشهر')}><input className="field-input" name="start_date" type="date" defaultValue={selected.start_date} readOnly={locked} required/></FormField><FormField label={tr('Profit basis','أساس الربح')}><select className="field-input" name="profit_basis" defaultValue={selected.profit_basis_confirmed?selected.profit_basis:''} disabled={locked} required><BasisOptions ar={ar}/></select>{locked?<input type="hidden" name="profit_basis" value={selected.profit_basis}/>:null}</FormField><FormField label={tr('End date (optional)','تاريخ النهاية (اختياري)')}><input className="field-input" name="end_date" type="date" defaultValue={selected.end_date??''}/></FormField><FormField label={tr('Payout cap (optional)','سقف التوزيعات (اختياري)')}><input className="field-input" name="payout_cap_lyd" type="number" step="0.01" min="0" defaultValue={selected.payout_cap_lyd??''}/></FormField><FormField label={tr('Status','الحالة')}><select className="field-input" name="status" defaultValue={selected.status}>{['draft','active','completed','cancelled'].map(status=><option key={status} value={status}>{status}</option>)}</select></FormField><FormField label={tr('Notes','ملاحظات')}><textarea className="field-input" name="notes" defaultValue={selected.notes??''} rows={2}/></FormField><button className="btn-primary">{tr('Save agreement','حفظ الاتفاق')}</button></form></details>
   </>}
  </div>
 </>;
}
