import Link from "next/link";

export type DashboardPriorityAction = {
  key: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
};

/** A compact first-screen action focus; the complete queue stays below. */
export function DashboardPriorityFocus({
  actions,
  remainingCount,
  partialSources,
  locale,
}: {
  actions: DashboardPriorityAction[];
  remainingCount: number;
  partialSources: boolean;
  locale: "en" | "ar";
}) {
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  return (
    <section aria-labelledby="dashboard-priority-title" className="mb-6 overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-emerald-950 px-5 py-5 text-white sm:px-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-300">
            {tr("SNACKY · TODAY", "سناكي · اليوم")}
          </p>
          <h2 id="dashboard-priority-title" className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
            {tr("Start with these priorities", "ابدأ بهذه الأولويات")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-emerald-100">
            {tr("The operating items that need attention first.", "أهم المهام التشغيلية التي تحتاج إلى متابعة الآن.")}
          </p>
        </div>
        <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold tabular-nums">
          {tr(`${actions.length} first`, `أول ${actions.length} مهام`)}
        </span>
      </div>
      {actions.length > 0 ? (
        <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-3">
          {actions.map((item, index) => (
            <Link key={item.key} href={item.href}
              className="group flex min-w-0 flex-col rounded-xl border border-slate-200 bg-slate-50 p-4 text-start transition-colors hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">
              <div className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-emerald-900">
                <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />
                {tr(`Priority ${index + 1}`, `الأولوية ${index + 1}`)}
              </div>
              <h3 className="text-base font-bold leading-6 text-slate-950">{item.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{item.detail}</p>
              <span className="mt-4 border-t border-slate-200 pt-3 text-sm font-semibold text-emerald-800 group-hover:text-emerald-950">{item.cta}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div role="status" className="px-5 py-6">
          <p className="font-semibold text-slate-900">
            {partialSources ? tr("Priority data is incomplete", "بيانات الأولويات غير مكتملة") : tr("No urgent actions found", "لا توجد مهام عاجلة")}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {partialSources
              ? tr("Some sources could not be verified. An empty queue is not an all-clear.", "تعذر التحقق من بعض البيانات، والقائمة الفارغة لا تعني خلو التشغيل من المشاكل.")
              : tr("Current operating queues are clear. Continue checking machines and stock as usual.", "قوائم التشغيل الحالية خالية من المهام العاجلة؛ واصل متابعة الأجهزة والمخزون.")}
          </p>
        </div>
      )}
      {remainingCount > 0 ? (
        <div className="border-t border-slate-100 px-5 py-3 text-sm">
          <a href="#dashboard-more-actions" className="font-semibold text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
            {tr(`See ${remainingCount} more actions`, `عرض ${remainingCount} مهام إضافية`)}
          </a>
        </div>
      ) : null}
      {partialSources ? (
        <div role="status" className="border-t border-amber-100 bg-amber-50 px-5 py-3 text-xs text-amber-950">
          {tr("Some data sources did not load; priorities reflect available records only.", "تعذر تحميل بعض البيانات؛ الأولويات معروضة حسب السجلات المتاحة فقط.")}
        </div>
      ) : null}
    </section>
  );
}
