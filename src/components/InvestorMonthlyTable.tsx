import type { InvestorLedgerResult, InvestorLedgerMonth } from "@/lib/investor-monthly-ledger";
import type { InvestorCashOutMonth } from "@/lib/investor-finance-outflow";
import type { InvestorSalesProof } from "@/lib/investor-sales-proof";
import Link from "next/link";

const money=(v:number|null)=>v===null?"—":new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const dollar=(v:number)=>"$"+money(v);
const names={
 en:["January","February","March","April","May","June","July","August","September","October","November","December"],
 ar:["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"]
};
const monthTitle=(month:string,ar:boolean)=>(ar?names.ar:names.en)[Number(month.slice(5,7))-1]+" "+month.slice(0,4);
const cents=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const shareOf=(row:InvestorLedgerMonth)=>row.dueLyd??row.estimatedShareLyd;
const balanceOf=(row:InvestorLedgerMonth)=>{
 const share=shareOf(row);
 return share===null||row.paidLyd===null?null:Math.max(0,cents(share-row.paidLyd));
};
function CashOutDisplay({month,ar}:{month?:InvestorCashOutMonth;ar:boolean}){
 if(!month)return <span className="text-slate-400">—</span>;
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 return <span className="block text-end tabular-nums">
  <span className="font-semibold">{month.recordedMoneyOutLyd===null?
   "≥"+money(month.knownMoneyOutLyd):money(month.recordedMoneyOutLyd)}</span>
  {month.missingFxCount>0?<span className="mt-1 block text-[11px] text-slate-600">
   {tr("Plus unconverted foreign debit","إضافة إلى صرف أجنبي غير محوّل")}: {money(month.missingFxNativeUsd)} USD
  </span>:null}
  {month.adjustmentLyd>0?<span className="mt-1 block text-[11px] text-slate-600">
   {tr("Budget adjustment included","يشمل تعديل الميزانية")}: {money(month.adjustmentLyd)}
  </span>:null}
 </span>;
}
export function InvestorMonthlyTable({ledger,investorName,sharePercent,ar,admin=false,cashOutByMonth,cashOutIssues,salesByMonth,ownerSourceEntries}:{
 ledger:InvestorLedgerResult;investorName:string;sharePercent:number|string|null;ar:boolean;admin?:boolean;
 cashOutByMonth?:Record<string,InvestorCashOutMonth>;cashOutIssues?:string[];
 salesByMonth?:Record<string,InvestorSalesProof>;
 ownerSourceEntries?:Array<{id:string;date:string;description:string;amount:number;currency:string}>
}){
 const tr=(en:string,arabic:string)=>ar?arabic:en;
 const totalShare=cents(ledger.totalDueLyd+ledger.totalEstimatedLyd);
 const totalBalance=Math.max(0,cents(totalShare-ledger.totalPaidLyd));
 const cashMonths=Object.values(cashOutByMonth??{});
 const duplicates=cashMonths.reduce((n,m)=>n+m.duplicateImportCount,0);
 const cashReviewCount=cashMonths.reduce((n,m)=>n+m.reviewedCount,0);
 const adjustments=cashMonths.reduce((n,m)=>n+m.adjustmentLyd,0);
 return <div className="space-y-4" dir={ar?"rtl":"ltr"}>
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
   <div className="relative overflow-hidden px-5 py-6 text-white sm:px-7" style={{backgroundColor:"var(--snacky-accent)"}}>
    <div aria-hidden className="absolute -end-14 -top-24 size-52 rounded-full border-[26px] border-white/10"/>
    <p className="relative text-[11px] font-bold uppercase tracking-[0.16em] text-white/80">
     {tr("SNACKY · INVESTOR ACCOUNT","سناكي · حساب المستثمر")}
    </p>
    <div className="relative mt-3 flex flex-wrap items-end justify-between gap-4">
     <div><h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{investorName}</h2>
      <p className="mt-1 text-sm text-white/85">{tr("Monthly profit statement · LYD","كشف الأرباح الشهرية · دينار ليبي")}</p>
     </div>
     {sharePercent!=null?<div className="rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-center">
      <strong className="block text-2xl tabular-nums">{sharePercent}%</strong>
      <span className="text-xs text-white/80">{tr("Profit share","نسبة الأرباح")}</span>
     </div>:null}
    </div>
   </div>
   <div className="grid grid-cols-3 divide-x divide-slate-100 px-2 py-5 text-center sm:px-5">
    {[
     [tr("Total calculated share","مجموع الحصة المحسوبة"),totalShare],
     [tr("Paid","المدفوع"),ledger.totalPaidLyd],
     [tr("Calculated balance","الرصيد المحسوب"),totalBalance]
    ].map(([label,value],i)=><div key={String(label)} className="min-w-0 px-1 sm:px-4">
     <p className="text-[10px] leading-4 text-slate-500 sm:text-xs">{label}</p>
     <strong dir="ltr" className={`mt-1 block text-base font-bold tabular-nums sm:text-2xl ${i===2?"text-emerald-800":"text-slate-900"}`}>{money(Number(value))}</strong>
     <span className="text-[10px] text-slate-500">{tr("LYD","د.ل")}</span>
    </div>)}
   </div>
  </section>
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-labelledby="investor-monthly-table-heading">
   <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
    <div>
     <h3 id="investor-monthly-table-heading" className="text-base font-bold text-slate-950 sm:text-lg">
      {tr("Monthly breakdown","التفصيل الشهري")}
     </h3>
     <p className="mt-1 text-xs text-slate-500">{tr("Recorded sales, costs and payments · LYD","المبيعات والتكاليف والدفعات المسجلة · دينار ليبي")}</p>
    </div>
    <span className="whitespace-nowrap rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
     {ledger.months.length} {tr("months","أشهر")}
    </span>
   </header>
   <div role="region" tabIndex={0} className="overflow-x-auto" aria-label={tr("Investor monthly profit table","جدول أرباح المستثمر الشهري")}>
    <table className="w-full min-w-[370px] border-collapse text-xs sm:text-sm">
     <thead><tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
      <th scope="col" className="px-3 py-3 text-start font-semibold sm:px-5">{tr("Month","الشهر")}</th>
      <th scope="col" className="hidden px-3 py-3 text-end font-semibold md:table-cell">{tr("Net profit · LYD","صافي الربح · د.ل")}</th>
      <th scope="col" className="px-2 py-3 text-end font-semibold sm:px-4">{tr("Share · LYD","الحصة · د.ل")}</th>
      <th scope="col" className="px-2 py-3 text-end font-semibold sm:px-4">{tr("Paid · LYD","المدفوع · د.ل")}</th>
      <th scope="col" className="px-2 py-3 text-end font-semibold sm:px-4">{tr("Balance · LYD","الرصيد · د.ل")}</th>
     </tr></thead>
     <tbody className="divide-y divide-slate-100">
      {ledger.months.map(row=><tr key={row.month} className="text-slate-800 hover:bg-emerald-50/30">
       <th scope="row" className="whitespace-nowrap px-3 py-3 text-start font-semibold sm:px-5">{monthTitle(row.month,ar)}</th>
       <td dir="ltr" className="hidden px-3 py-3 text-end tabular-nums md:table-cell">{money(row.netProfitLyd)}</td>
       <td dir="ltr" className="px-2 py-3 text-end font-bold tabular-nums text-slate-950 sm:px-4">{money(shareOf(row))}</td>
       <td dir="ltr" className="px-2 py-3 text-end tabular-nums sm:px-4">{money(row.paidLyd)}</td>
       <td dir="ltr" className="px-2 py-3 text-end font-semibold tabular-nums sm:px-4">{money(balanceOf(row))}</td>
      </tr>)}
     </tbody>
     {ledger.months.length>0?<tfoot className="border-t-2 border-slate-200 bg-slate-50 text-slate-950">
      <tr><th scope="row" className="px-3 py-3 text-start font-bold sm:px-5">{tr("Total","المجموع")}</th>
       <td className="hidden md:table-cell"/>
       <td dir="ltr" className="px-2 py-3 text-end font-bold tabular-nums sm:px-4">{money(totalShare)}</td>
       <td dir="ltr" className="px-2 py-3 text-end font-bold tabular-nums sm:px-4">{money(ledger.totalPaidLyd)}</td>
       <td dir="ltr" className="px-2 py-3 text-end font-bold tabular-nums sm:px-4">{money(totalBalance)}</td>
      </tr>
     </tfoot>:null}
    </table>
   </div>
   {!ledger.months.length?<p className="px-5 py-6 text-sm text-slate-600">{tr("No monthly records yet.","لا توجد سجلات شهرية حتى الآن.")}</p>:null}
  </section>
  {admin&&cashMonths.length>0?<details className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5">
   <summary className="cursor-pointer text-sm font-semibold text-slate-800">
    {tr("Internal accounting source evidence","مستندات مطابقة الحسابات الداخلية")}
   </summary>
   <div className="mt-4 space-y-3">
    <p className="text-xs leading-5 text-slate-600">
     {tr("The cash-out register includes every active debit, including budget adjustments. Exact duplicate source imports are counted once. Product purchases and transfers remain recorded without double-charging the agreed operating-profit formula.",
      "يشمل سجل الصرف جميع الحركات الخارجة النشطة بما فيها تعديل الميزانية. لا تتكرر حركات الاستيراد المتطابقة. تظهر مشتريات المنتجات والتحويلات دون خصمها مرتين من الربح التشغيلي المتفق عليه.")}
    </p>
    {salesByMonth&&Object.keys(salesByMonth).length>0?<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
     {Object.values(salesByMonth).sort((a,b)=>a.month.localeCompare(b.month)).map(proof=>
      <div key={proof.month} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
       <strong className="text-slate-800">{monthTitle(proof.month,ar)}</strong>
       <p className="mt-1 text-slate-600">{tr("XY product records","سجلات مبيعات XY")}: {proof.xyRows} · {tr("Manual sales","مبيعات يدوية")}: {proof.manualSales}</p>
       <p className="mt-1 text-slate-600">{tr("Costs matched to dated inventory records","تكاليف طابقت سجلات مخزون مؤرخة")}: {proof.datedCostMatches}</p>
       {proof.unresolvedCostCount>0?<p className="mt-1 text-slate-600">{tr("Missing source cost entries","سجلات تكلفة دون مصدر")}: {proof.unresolvedCostCount}</p>:null}
      </div>)}
    </div>:null}
    <div className="overflow-x-auto"><table className="w-full min-w-[360px] text-xs">
     <thead><tr className="border-b border-slate-200 text-slate-600">
      <th className="py-2 text-start">{tr("Month","الشهر")}</th>
      <th className="py-2 text-end">{tr("Finance money out","الصرف المالي")}</th>
      <th className="py-2 text-end">{tr("Source entries","عدد الحركات")}</th>
     </tr></thead>
     <tbody className="divide-y divide-slate-100">
      {cashMonths.sort((a,b)=>a.period.localeCompare(b.period)).map(month=><tr key={month.period}>
       <td className="py-2 font-medium">{monthTitle(month.period+"-01",ar)}</td>
       <td className="py-2"><CashOutDisplay month={month} ar={ar}/></td>
       <td dir="ltr" className="py-2 text-end tabular-nums">{month.actualRowCount}</td>
      </tr>)}
     </tbody>
    </table></div>
    <p className="text-xs text-slate-500">
     {tr("Budget adjustments included","تعديلات الميزانية المحتسبة")}: {money(adjustments)} LYD ·
     {tr("Mirrored imports identified","نسخ الاستيراد المتطابقة")}: {duplicates} ·
     {tr("Source entries awaiting supporting evidence","حركات تحتاج مستندات داعمة")}: {cashReviewCount}
    </p>
    {ownerSourceEntries&&ownerSourceEntries.length>0?<div className="rounded-lg border border-slate-200 p-3">
     <p className="text-xs font-semibold text-slate-700">{tr("Original Finance source entries","حركات المالية الأصلية")} · {ownerSourceEntries.length}</p>
     <div className="mt-2 space-y-2">{ownerSourceEntries.map(r=><div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs">
      <span>{r.date} · {r.description} · <strong>{money(r.amount)} {r.currency}</strong></span>
      {r.id?<Link href={`/finance/transactions/${r.id}`} className="font-semibold text-emerald-800 underline underline-offset-2">
       {tr("View source","عرض المصدر")}
      </Link>:null}
     </div>)}</div>
    </div>:null}
    {cashOutIssues?.length?<p className="text-xs text-slate-500">
     {tr("Foreign-currency cash entries without a dated rate remain in their original currency; they are not silently converted.","تظل حركات الصرف الأجنبي دون سعر موثق بعملتها الأصلية ولا تُحوّل تلقائياً.")}
    </p>:null}
   </div>
  </details>:null}
  <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <div><h3 className="font-bold text-slate-950">{tr("Contractual payout goal","سقف التوزيعات المتفق عليه")}</h3>
     <p className="mt-1 text-xs text-slate-500">{tr("Only actual LYD payments are credited at their payment-day exchange rate","يُحتسب فقط ما دُفع فعلياً بالدينار وفق سعر الصرف يوم الدفع")}</p>
    </div>
    <strong dir="ltr" className="text-sm tabular-nums">{dollar(ledger.creditedUsd)} / {dollar(ledger.goalUsd)}</strong>
   </div>
   <div role="progressbar" aria-valuenow={ledger.progressPercent} aria-valuemin={0} aria-valuemax={100}
    aria-label={tr("Payout goal progress","التقدم نحو سقف التوزيعات")} className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
    <div className="h-full rounded-full" style={{width:ledger.progressPercent+"%",backgroundColor:"var(--snacky-accent)"}}/>
   </div>
   <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-600">
    <span>{ledger.progressPercent.toFixed(1)}% {tr("of goal paid","من الهدف تم دفعه")}</span>
    <span>{tr("Remaining goal","المتبقي من الهدف")}: <strong dir="ltr">{dollar(ledger.remainingGoalUsd)}</strong></span>
   </div>
  </section>
 </div>;
}
