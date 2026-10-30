import type { InvestorLedgerResult, InvestorLedgerMonth } from "@/lib/investor-monthly-ledger";

const money = (v: number | null) => v === null ? "—" : new Intl.NumberFormat("en-US", {minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const dollar = (v: number) => "$" + money(v);
const names = {
 en: ["January","February","March","April","May","June","July","August","September","October","November","December"],
 ar: ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"]
};
const monthTitle = (month: string, ar: boolean) => (ar ? names.ar : names.en)[Number(month.slice(5,7))-1] + " " + month.slice(0,4);
const labels = {
 unpaid: ["Unpaid","غير مدفوع","border-amber-200 bg-amber-50 text-amber-800"],
 partial: ["Partly paid","مدفوع جزئياً","border-sky-200 bg-sky-50 text-sky-800"],
 paid: ["Paid","مدفوع","border-emerald-200 bg-emerald-50 text-emerald-800"],
 nothing_due: ["No payout due","لا يوجد مستحق","border-slate-200 bg-slate-50 text-slate-600"],
 pending: ["Under review","قيد المراجعة","border-slate-200 bg-slate-50 text-slate-600"],
 unverified: ["Needs confirmation","بحاجة للتأكيد","border-rose-200 bg-rose-50 text-rose-800"]
} as const;
function Badge({row,ar}:{row:InvestorLedgerMonth;ar:boolean}) {
 const info=labels[row.status];
 return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold leading-tight sm:text-xs ${info[2]}`}>{ar?info[1]:info[0]}</span>;
}
export function InvestorMonthlyTable({ledger,investorName,sharePercent,ar}:{
 ledger:InvestorLedgerResult;investorName:string;sharePercent:number|string|null;ar:boolean
}) {
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 return <div className="space-y-4" dir={ar?"rtl":"ltr"}>
  <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-label={tr("Investment summary","ملخص الاستثمار")}>
   <div className="relative overflow-hidden px-4 py-5 text-white sm:px-6" style={{backgroundColor:"var(--snacky-accent)"}}>
    <div aria-hidden className="absolute -end-10 -top-16 size-44 rounded-full border-[24px] border-white/10" />
    <p className="relative flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-white/80">
     <span className="size-2 rounded-full" style={{backgroundColor:"var(--snacky-primary)"}} />
     {tr("SNACKY · INVESTOR STATEMENT","سناكي · كشف المستثمر")}
    </p>
    <div className="relative mt-3 flex flex-wrap items-end justify-between gap-3">
     <div><h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{investorName}</h2>
      <p className="mt-1 text-sm text-white/80">{tr("Monthly profit & actual payments · LYD","الأرباح الشهرية والدفعات الفعلية · دينار ليبي")}</p></div>
     {sharePercent!=null?<div className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-center">
      <strong className="block text-2xl">{sharePercent}%</strong>
      <span className="text-xs text-white/80">{tr("Profit share","نسبة الأرباح")}</span>
     </div>:null}
    </div>
   </div>
   <div className="grid grid-cols-2 gap-y-4 sm:grid-cols-4 px-1 py-4 text-center sm:px-3 sm:py-5">
    {[
     [tr("Approved share","حصة الأرباح المعتمدة"),ledger.totalDueLyd],
     [tr("Actually paid","المدفوع فعلياً"),ledger.totalPaidLyd],
     [tr("Still unpaid","المتبقي غير المدفوع"),ledger.totalOutstandingLyd]
    ].map(([label,value],i)=><div key={String(label)} className="min-w-0 px-1 sm:px-3">
     <p className="text-[10px] leading-4 text-slate-500 sm:text-xs">{label}</p>
     <strong dir="ltr" className={`mt-1 block whitespace-nowrap text-base font-bold tabular-nums sm:text-2xl ${i===2?"text-amber-700":"text-slate-900"}`}>{money(Number(value))}</strong>
     <span className="text-[10px] text-slate-400">{tr("LYD","د.ل")}</span>
    </div>)}
   </div>
  </section>
  <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-labelledby="investor-monthly-table-heading">
   <header className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-200 px-4 py-4 sm:px-5">
    <div><h3 id="investor-monthly-table-heading" className="text-lg font-bold text-slate-950">{tr("Monthly profit statement","كشف الأرباح الشهرية")}</h3>
     <p className="mt-1 text-xs text-slate-500">{tr("All values are LYD. Months under review do not have an approved payable amount yet.","جميع المبالغ بالدينار. الأشهر قيد المراجعة ليس لها مستحق معتمد بعد.")}</p></div>
    <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{ledger.months.length} {tr("months","أشهر")}</span>
   </header>
   <div role="region" tabIndex={0} className="overflow-x-auto" aria-label={tr("Investor profits by month","أرباح المستثمر حسب الشهر")}>
    <table className="w-full min-w-[340px] border-collapse text-xs sm:text-sm">
     <thead><tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
      <th scope="col" className="min-w-[92px] px-2 py-3 text-start font-semibold sm:px-4">{tr("Month","الشهر")}</th>
      <th scope="col" className="hidden px-3 py-3 text-end font-semibold lg:table-cell">{tr("Net profit · LYD","صافي الربح · د.ل")}</th>
      <th scope="col" className="px-1 py-3 text-end font-semibold sm:px-3">{tr("Share · LYD","الحصة · د.ل")}</th>
      <th scope="col" className="px-1 py-3 text-end font-semibold sm:px-3">{tr("Paid · LYD","المدفوع · د.ل")}</th>
      <th scope="col" className="px-1 py-3 text-end font-semibold sm:px-3">{tr("Unpaid · LYD","المتبقي · د.ل")}</th>
      <th scope="col" className="hidden px-3 py-3 text-start font-semibold sm:table-cell">{tr("Status","الحالة")}</th>
     </tr></thead>
     <tbody className="divide-y divide-slate-100">
      {ledger.months.map(row=><tr key={row.month} className={row.status==="pending"?"bg-slate-50/50 text-slate-500":"text-slate-800 hover:bg-emerald-50/30"}>
       <th scope="row" className="px-2 py-3 text-start font-semibold sm:px-4">
        <span className="block whitespace-nowrap">{monthTitle(row.month,ar)}</span>
        <span className="mt-1 block sm:hidden"><Badge row={row} ar={ar}/></span>
       </th>
       <td dir="ltr" className="hidden px-3 py-3 text-end tabular-nums lg:table-cell">{row.netProfitLyd===null?"—":money(row.netProfitLyd)}</td>
       <td dir="ltr" className="px-1 py-3 text-end font-bold tabular-nums sm:px-3">{money(row.dueLyd)}</td>
       <td dir="ltr" className="px-1 py-3 text-end tabular-nums sm:px-3">{money(row.paidLyd)}</td>
       <td dir="ltr" className="px-1 py-3 text-end font-semibold tabular-nums sm:px-3">{money(row.outstandingLyd)}</td>
       <td className="hidden px-3 py-3 text-start sm:table-cell"><Badge row={row} ar={ar}/></td>
      </tr>)}
     </tbody>
     {ledger.months.length>0?<tfoot className="border-t-2 border-slate-200 bg-slate-50 text-slate-950"><tr>
      <th scope="row" className="px-2 py-3 text-start font-bold sm:px-4">{tr("Total approved","مجموع المعتمد")}</th>
      <td className="hidden lg:table-cell"/>
      <td dir="ltr" className="px-1 py-3 text-end font-bold tabular-nums sm:px-3">{money(ledger.totalDueLyd)}</td>
      <td dir="ltr" className="px-1 py-3 text-end font-bold tabular-nums sm:px-3">{money(ledger.totalPaidLyd)}</td>
      <td dir="ltr" className="px-1 py-3 text-end font-bold tabular-nums sm:px-3">{money(ledger.totalOutstandingLyd)}</td>
      <td className="hidden sm:table-cell"/>
     </tr></tfoot>:null}
    </table>
   </div>
   {!ledger.months.length?<p className="px-5 py-5 text-sm text-slate-600">{tr("No monthly source records are available for this agreement yet.","لا توجد سجلات شهرية لهذه الاتفاقية بعد.")}</p>:null}
   {ledger.months.some(m=>m.status==="pending")?<p className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs text-slate-600 sm:px-5">
    {tr("Under review means the amount is not approved yet; it does not mean profit is zero.","قيد المراجعة يعني أن المبلغ لم يُعتمد بعد، وليس أن الأرباح صفر.")}
   </p>:null}
   {ledger.needsReview?<p role="alert" className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
    {tr("Some records need reconciliation. Confirmed amounts remain visible; further payments are blocked until resolved.","بعض السجلات تحتاج مطابقة. المبالغ المؤكدة ظاهرة؛ ولا يمكن تسجيل دفعات جديدة قبل المعالجة.")}
   </p>:null}
  </section>
  <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5">
   <div className="flex flex-wrap items-center justify-between gap-2"><div>
    <h3 className="font-bold text-slate-950">{tr("Contractual payout goal","سقف التوزيعات المتفق عليه")}</h3>
    <p className="mt-1 text-xs text-slate-500">{tr("USD equivalent of actual payments only","المعادل بالدولار للدفعات الفعلية فقط")}</p>
   </div><strong dir="ltr" className="text-sm tabular-nums">{dollar(ledger.creditedUsd)} / {dollar(ledger.goalUsd)}</strong></div>
   <div role="progressbar" aria-valuenow={ledger.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label={tr("Payout goal progress","التقدم نحو سقف التوزيعات")} className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
    <div className="h-full rounded-full" style={{width:ledger.progressPercent+"%",backgroundColor:"var(--snacky-accent)"}}/>
   </div>
   <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-600">
    <span>{ledger.progressPercent.toFixed(1)}% {tr("of goal paid","من الهدف تم دفعه")}</span>
    <span>{tr("Remaining goal","المتبقي من الهدف")}: <strong dir="ltr">{dollar(ledger.remainingGoalUsd)}</strong></span>
   </div>
   <p className="mt-2 text-xs text-slate-500">{tr("Each actual LYD payment keeps its own dated FX rate. No exchange rate is applied to the monthly table.","لكل دفعة دينار فعلية سعر صرف ثابت بتاريخها. لا يُستخدم سعر صرف في جدول الأرباح الشهري.")}</p>
  </section>
 </div>;
}
