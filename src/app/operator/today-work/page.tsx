import Link from 'next/link';
import { getServerI18n } from '@/lib/i18n/server';
import { loadSmartWorkBoard } from '@/lib/smart-work-board-server';
import type { WorkPriority } from '@/lib/smart-work-board';
import BoardRefresh from './BoardRefresh';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
const labels: Record<WorkPriority, [string,string]> = {
  immediate:['Immediate attention','أولوية فورية'], urgent:['Fill as soon as possible','تعبئة بأقرب وقت'],
  today:['Fill today','تعبئة اليوم'], monitor:['Monitor','متابعة'], healthy:['Well stocked','المخزون جيد'], verify:['Verify readings','تحقق من القراءات'],
};
const styles: Record<WorkPriority,string> = {immediate:'border-red-200 bg-red-50 text-red-900',urgent:'border-orange-200 bg-orange-50 text-orange-900',today:'border-amber-200 bg-amber-50 text-amber-900',monitor:'border-slate-200 bg-slate-50 text-slate-700',healthy:'border-emerald-200 bg-emerald-50 text-emerald-900',verify:'border-violet-200 bg-violet-50 text-violet-900'};
export default async function TodayWorkPage() {
  const {locale} = await getServerI18n();
  const ar = locale==='ar';
  const t = (en:string,arabic:string)=>ar?arabic:en;
  let data: Awaited<ReturnType<typeof loadSmartWorkBoard>>;
  try { data = await loadSmartWorkBoard(); }
  catch { return <section dir={ar?'rtl':'ltr'} className="surface-card space-y-4" role="alert">
    <h1 className="text-xl font-bold">{t('Work board unavailable','لوحة العمل غير متاحة')}</h1>
    <p>{t('Readings or access could not be verified. This does not mean the machines are stocked. Continue using your assigned routes.','تعذّر التحقق من القراءات أو صلاحية الدخول. هذا لا يعني أن الأجهزة ممتلئة. استخدم الجولات المسندة إليك.')}</p>
    <Link href="/operator" className="btn-secondary">{t('Back to assigned work','العودة للعمل المسند')}</Link>
  </section>; }
  const time = (value:string|null)=>value ? new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{timeZone:'Africa/Tripoli',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)) : '—';
  return <main dir={ar?'rtl':'ltr'} className="mx-auto max-w-5xl space-y-5 pb-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm text-slate-500">SNACKY · {data.businessDate}</p><h1 className="mt-1 text-3xl font-bold text-slate-950">{t('Today’s Work','عمل اليوم')}</h1><p className="mt-2 text-sm text-slate-600">{t('Machine priorities and existing assignments. Libya time.','أولويات الأجهزة والتكليفات الحالية. بتوقيت ليبيا.')}</p></div>
      <Link href="/operator" className="btn-secondary min-h-11">{t('Assigned routes','الجولات المسندة')}</Link>
    </header>
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
      <strong>{t('View only — your current workflow stays unchanged.','للعرض فقط — طريقة العمل الحالية لم تتغير.')}</strong>{' '}
      {t('This screen does not assign work, prepare pickup quantities, or reserve stock. Use an assigned route to collect products.','هذه الشاشة لا تسند عملاً ولا تجهّز كميات التحميل ولا تحجز مخزوناً. استلام المنتجات يكون عبر جولة مسندة.')}
    </div>
    <section aria-label={t('Coverage overview','ملخص التغطية')} className="grid grid-cols-3 gap-2 sm:gap-4">
      {[[t('Need filling','تحتاج تعبئة'),data.totals.due],[t('Without an operator','بدون مشغّل'),data.totals.uncovered],[t('Need checking','تحتاج تحقق'),data.totals.verify]].map(([label,count])=><div key={label} className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4"><div className="text-2xl font-bold">{count}</div><div className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">{label}</div></div>)}
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-500">{t('Board checked','تحديث اللوحة')}: {time(data.generatedAt)}</p><BoardRefresh ar={ar} generatedAt={data.generatedAt}/></div>
    {!data.board.length ? <p className="surface-card">{t('No active machines were returned. Verify the setup; this is not a completed workday.','لم تُرجع البيانات أي أجهزة نشطة. تحقق من الإعدادات؛ هذا لا يعني اكتمال عمل اليوم.')}</p> : null}
    <section className="grid gap-4 md:grid-cols-2" aria-label={t('Machines','الأجهزة')}>
      {data.board.map(m=><article key={m.machineId} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="min-w-0 break-words text-lg font-bold text-slate-950">{m.name}</h2><span className={`rounded-full border px-3 py-1 text-xs font-semibold ${styles[m.priority]}`}>{labels[m.priority][ar?1:0]}</span></div>
        <div className="my-4 grid grid-cols-3 gap-2 text-center">
          {[[m.empty,t('Empty','فارغة')],[m.low,t('Low','منخفضة')],[m.averageLaneFullness===null?'—':`${m.averageLaneFullness}%`,t('Lane fullness','امتلاء الفتحات')]].map(([count,label])=><div key={label} className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold tabular-nums">{count}</div><div className="text-xs text-slate-600">{label}</div></div>)}
        </div>
        <p className="text-xs text-slate-600">{m.knownLanes}/{m.lanes} {t('lanes have valid current readings','فتحات بقراءات حالية صالحة')}</p>
        {m.unknown>0 || m.unmapped>0 ? <p className="mt-2 rounded-lg bg-violet-50 p-2 text-sm text-violet-900">{m.unknown} {t('unknown readings','قراءات غير مؤكدة')} · {m.unmapped} {t('products need mapping','منتجات تحتاج ربطاً')}. {t('No quantities are guessed.','لا يتم تخمين الكميات.')}</p> : null}
        {m.openToday!==true ? <p className="mt-2 text-sm text-amber-900">{m.openToday===false?t('Closed today according to saved access days; urgency stays visible.','مغلق اليوم بحسب أيام الدخول المحفوظة؛ تبقى الأولوية ظاهرة.'):t('Site access days are not configured.','أيام الدخول للموقع غير محددة.')}</p> : null}
        <div className="mt-4 border-t border-slate-100 pt-3">
          {m.uncovered ? <p className="mb-2 font-semibold text-red-800">{t('Needs coverage — no active operator assigned','تحتاج تغطية — لا يوجد مشغّل نشط مسند')}</p> : null}
          {m.assignmentConflict ? <p className="mb-2 font-semibold text-red-800">{t('Multiple open visits: check for duplicate assignments.','أكثر من زيارة مفتوحة: تحقق من تكرار التكليف.')}</p> : null}
          {m.assignments.map((a,i)=><div key={i} className="mt-2 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-semibold">{a.operatorName || t('Route has no operator','الجولة بدون مشغّل')}{a.mine?` · ${t('Your route','جولتك')}`:''}</p>
            {!a.covered && a.operatorName ? <p className="text-red-800">{t('Operator inactive — coverage needs review.','المشغّل غير نشط — التغطية تحتاج مراجعة.')}</p> : null}
            <p className="mt-1 text-xs text-slate-600">{a.routeDate}{a.previousDate?` · ${t('Open from an earlier date — follow up','مفتوحة من يوم سابق — تحتاج متابعة')}`:''}</p>
            {a.href?<Link href={a.href} prefetch={false} className="mt-2 inline-block font-semibold text-emerald-800 underline">{t('Open existing route','فتح الجولة الحالية')}</Link>:null}
          </div>)}
          {!m.assignments.length && !m.needsService ? <p className="text-sm text-slate-600">{t('No open route assignment','لا توجد جولة مفتوحة مسندة')}</p> : null}
        </div>
        <p className="mt-3 text-xs text-slate-500">{t('Oldest lane reading','أقدم قراءة للفتحات')}: {time(m.oldestSnapshotAt)}</p>
      </article>)}
    </section>
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600"><summary className="cursor-pointer font-semibold">{t('How priorities are calculated','كيف تُحسب الأولويات')}</summary><p className="mt-2">{t('16–19 empty lanes: today. 20–24: urgent. 25+: immediate. Many nearly empty lanes or very low overall lane fullness raise urgency earlier. Low means 1–2 units or at most 20% capacity. Missing or old readings are unknown, not empty. This is a current snapshot, not a saved daily duty list.','16–19 فتحة فارغة: اليوم. 20–24: عاجل. 25 فأكثر: فوري. كثرة الفتحات المنخفضة أو انخفاض متوسط الامتلاء يرفعان الأولوية مبكراً. المنخفضة: وحدة أو وحدتان أو 20% من السعة فأقل. القراءات الناقصة أو القديمة غير مؤكدة وليست صفراً. هذه لقطة حالية وليست قائمة واجبات يومية محفوظة.')}</p></details>
  </main>;
}
