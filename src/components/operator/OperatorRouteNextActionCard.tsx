import Link from "next/link";
import type { OperatorRouteNextFocus } from "@/lib/operator-route-next-focus";

export function OperatorRouteNextActionCard({
  focus,
  machineName,
  hasPickup,
  actionLabel,
  locale,
}: {
  focus: OperatorRouteNextFocus;
  machineName: string | null;
  hasPickup: boolean;
  actionLabel: string;
  locale: "ar" | "en";
}) {
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const fraction = focus.totalStops
    ? Math.round(focus.doneStops / focus.totalStops * 100) : 0;

  return (
    <section aria-labelledby="operator-next-action-title"
      className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 bg-emerald-950 px-4 py-4 text-white sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-300">{tr("SNACKY · NEXT STEP", "سناكي · الخطوة التالية")}</p>
          <h2 id="operator-next-action-title" className="mt-1 text-xl font-bold">
            {focus.kind === "pickup"
              ? tr(hasPickup ? "Complete remaining storage pickup" : "Pick products from storage",
                hasPickup ? "استكمل استلام المنتجات من المخزن" : "استلم المنتجات من المخزن")
              : focus.kind === "leftovers"
                ? tr("Count and return remaining stock", "عدّ المتبقي وأرجعه للمخزن")
                : tr("Continue filling this machine", "تابع تعبئة هذا الجهاز")}
          </h2>
          {focus.kind === "machine" && machineName ? (
            <p className="mt-1 break-words text-sm font-semibold text-emerald-100">{machineName}</p>
          ) : null}
          <p className="mt-1 text-xs leading-5 text-emerald-100">
            {focus.kind === "pickup"
              ? tr("Complete approved storage pickup before machine filling.", "أكمل استلام المخزون المعتمد قبل تعبئة الأجهزة.")
              : focus.kind === "leftovers"
                ? tr("Stops have finished or been skipped. Physically count bag stock before finalizing.", "المواقع مكتملة أو متخطاة. عدّ محتويات الحقيبة فعلياً قبل إنهاء الجولة.")
                : tr("Suggested next stop; you can still choose another eligible machine below.", "الموقع التالي المقترح، ويمكنك اختيار جهاز آخر متاح من القائمة أدناه.")}
          </p>
        </div>
        <Link href={focus.href}
          className="flex min-h-12 w-full shrink-0 items-center justify-center rounded-xl bg-amber-400 px-5 py-3 text-center text-sm font-bold text-slate-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-emerald-950 sm:w-auto">
          {actionLabel}
        </Link>
      </div>
      <div className="px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <strong className="text-slate-900">{tr("Route progress", "تقدم الجولة")}</strong>
          <span dir="ltr" className="tabular-nums text-slate-700">{focus.doneStops} / {focus.totalStops}</span>
        </div>
        <div role="progressbar" aria-label={tr("Completed or skipped stops", "المواقع المكتملة أو المتخطاة")}
          aria-valuemin={0} aria-valuemax={Math.max(1, focus.totalStops)}
          aria-valuenow={focus.doneStops}
          className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-600" style={{ width: fraction + "%" }} />
        </div>
        {focus.unfinishedStops > 0 ? <a href="#route-machine-stops"
          className="mt-3 inline-block min-h-10 py-2 text-sm font-semibold text-emerald-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
          {tr("Review " + focus.unfinishedStops + " unfinished stops", "عرض " + focus.unfinishedStops + " مواقع غير منتهية")}
        </a> : null}
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {tr("Progress counts completed and skipped stops; it does not certify cash or physical inventory.", "يشمل التقدم المواقع المكتملة والمتخطاة، ولا يثبت النقد أو الجرد الفعلي للمخزون.")}
        </p>
      </div>
    </section>
  );
}
