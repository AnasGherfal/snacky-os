import Link from "next/link";
import type { DueRouteCloseout, DueRouteAction } from "@/lib/owner-daily-closeout";

const actionLabels: Record<DueRouteAction, {en:string;ar:string}> = {
  return_bag_count: {
    en:"All stops accounted for · review final bag count",
    ar:"تم التعامل مع المواقع · راجع العدّ النهائي للحقيبة",
  },
  finish_machine_stops: {
    en:"Machine stops still unfinished",
    ar:"مواقع أجهزة لم تكتمل بعد",
  },
  review_route: {
    en:"Route setup or workflow needs review",
    ar:"إعداد الجولة أو حالتها بحاجة للمراجعة",
  },
};

export function OwnerDailyCloseoutActionCenter({
  locale,
  date,
  routes,
  todayCashNotCounted,
  allCashNotCounted,
  pendingCashReviews,
  openRouteStockDifferences,
}: {
  locale:"ar"|"en";
  date:string;
  routes:DueRouteCloseout|null;
  todayCashNotCounted:number|null;
  allCashNotCounted:number|null;
  pendingCashReviews:number|null;
  openRouteStockDifferences:number|null;
}) {
  const ar=locale==="ar";
  const tr=(en:string,arabic:string)=>ar?arabic:en;
  const counts=[
    {
      title:tr("Due routes still open", "جولات مستحقة ولم تُغلق"),
      count:routes?.totalDueOpenRoutes ?? null,
      detail:tr("Scheduled today or earlier; future routes excluded.", "المجدولة اليوم أو قبله؛ لا تشمل الجولات القادمة."),
      href:"/routes",
    },
    {
      title:tr("Final bag count to review", "جولات تحتاج مراجعة إرجاع الحقيبة"),
      count:routes?.routesNeedingBagCountReview ?? null,
      detail:tr("All stops done or skipped; physical return NOT verified.", "كل المواقع مكتملة أو متخطاة؛ تسليم المخزون الفعلي غير مؤكد."),
      href:"/routes",
    },
    {
      title:tr("Machine stops unfinished", "جولات بها مواقع غير منتهية"),
      count:routes?.routesWithUnfinishedStops ?? null,
      detail:tr("Finish or explicitly skip the remaining stops.", "أكمل المواقع المتبقية أو تخطّها بشكل صريح."),
      href:"/routes",
    },
    {
      title:tr("Cash removals without count", "تحصيلات نقد دون عدّ مسجل"),
      count:allCashNotCounted,
      detail:tr("All dates, including older cash. Today's uncounted: ", "جميع التواريخ، بما فيها النقد السابق. غير المعدود اليوم: ")
        +(todayCashNotCounted===null?tr("Unverified", "غير مؤكد"):String(todayCashNotCounted)),
      href:"/cash-collections",
    },
    {
      title:tr("Cash reconciliation pending or variance", "نقد بانتظار التسوية أو مراجعة الفروقات"),
      count:pendingCashReviews,
      detail:tr("All dates, including older records; not an asserted cash loss.", "كل التواريخ بما فيها السجلات القديمة؛ لا يعني فقد نقد مثبت."),
      href:"/cash-collections",
    },
    {
      title:tr("Open route stock discrepancies", "فروقات مخزون الجولات المفتوحة"),
      count:openRouteStockDifferences,
      detail:tr("Audit cases—not automatically written off.", "حالات للمراجعة ولا يتم شطبها تلقائياً."),
      href:"/routes/inventory-review",
    },
  ];

  const dataIncomplete=routes===null || counts.some(row=>row.count===null);
  return (
    <section aria-labelledby="owner-closeout-review-title"
      className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 bg-emerald-950 px-4 py-5 text-white sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-300">{tr("SNACKY · OWNER OPERATIONS", "سناكي · متابعة الإدارة")}</p>
          <h2 id="owner-closeout-review-title" className="mt-1 text-xl font-bold">
            {tr("Closeout actions that need attention", "مهام الإغلاق التي تحتاج متابعة")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-emerald-100">
            {tr("What still needs management review, as of the Tripoli business date.",
              "ما يحتاج مراجعة الإدارة حتى تاريخ العمل بتوقيت طرابلس.")}
            {" "}<span dir="ltr" className="inline-block font-semibold tabular-nums">{date}</span>
          </p>
        </div>
        <Link href="/cash-collections/action-queue"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200">
          {tr("Review cash actions", "راجع مهام النقد")}
        </Link>
      </div>

      {dataIncomplete ? (
        <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-5">
          {tr("Some closeout sources are unverified. An unknown count is not zero and an empty list is not an all-clear.",
            "بعض مصادر الإغلاق غير مؤكدة. العدد المجهول ليس صفراً والقائمة الفارغة لا تعني خلوها من المهام.")}
        </div>
      ) : null}

      <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
        {counts.map(item=>(
          <Link key={item.href+item.title} href={item.href}
            className="flex min-h-32 flex-col rounded-xl border border-slate-200 bg-slate-50 p-4 transition-colors hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
            <span className="text-xs font-semibold leading-5 text-slate-600">{item.title}</span>
            <strong className={item.count===null?"mt-2 text-base text-amber-800":"mt-2 text-2xl tabular-nums text-slate-950"}>
              {item.count===null?tr("Unverified", "غير مؤكد"):item.count}
            </strong>
            <p className="mt-2 flex-1 text-xs leading-5 text-slate-600">{item.detail}</p>
            <span className="mt-2 text-xs font-semibold text-emerald-800">{tr("Review", "مراجعة")}</span>
          </Link>
        ))}
      </div>

      <div className="border-t border-slate-200 px-4 py-4 sm:px-5">
        <h3 className="text-base font-bold text-slate-950">{tr("Routes to follow up", "الجولات المطلوب متابعتها")}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          {tr("Due-dated, non-terminal routes only. A finished stop is not proof of a returned bag or reconciled cash.",
            "جولات مستحقة لم تُغلق فقط. إنهاء الموقع لا يثبت إرجاع الحقيبة أو تسوية النقد.")}
        </p>
        {routes===null ? (
          <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            {tr("Route and stop records could not be fully verified. Review the route list; do not assume everything is finished.",
              "تعذر التحقق الكامل من سجلات الجولات والمواقع. راجع قائمة الجولات ولا تفترض اكتمال العمل.")}
          </p>
        ) : routes.totalDueOpenRoutes===0 ? (
          <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
            {tr("No due open routes in the verified route source. Cash and inventory exceptions require separate review.",
              "لا توجد جولات مستحقة مفتوحة في سجلات الجولات المتحقق منها. تبقى مراجعة النقد وفروقات المخزون مستقلة.")}
          </p>
        ) : (
          <>
            <div className="mt-3 space-y-2">
              {routes.routeQueue.map(route=>(
                <article key={route.routeId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
                  <div className="min-w-0">
                    <strong className="text-sm font-semibold text-slate-950">
                      {ar?"جولة":"Route"}{" "}<span dir="ltr" className="inline-block tabular-nums">{route.routeId.slice(0,8).toUpperCase()}</span>
                      {" · "}<span dir="ltr" className="inline-block tabular-nums">{route.routeDate||"—"}</span>
                    </strong>
                    <p className="mt-1 text-xs font-semibold text-amber-900">
                      {ar?actionLabels[route.action].ar:actionLabels[route.action].en}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {tr("Stops completed/skipped", "المواقع المكتملة أو المتخطاة")}:{" "}
                      <span dir="ltr" className="inline-block tabular-nums">{route.completedOrSkippedStops}/{route.totalStops}</span>
                      {" · "}{tr("Unfinished", "غير منتهية")}: {route.unfinishedStops}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {route.action==="return_bag_count" ? (
                      <Link href={`/operator/routes/${route.routeId}/leftovers`}
                        className="inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
                        {tr("Review physical bag count", "راجع العدّ الفعلي للحقيبة")}
                      </Link>
                    ) : null}
                    <Link href={`/routes/${route.routeId}`}
                      className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                      {tr("Open route", "فتح الجولة")}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
            {routes.totalDueOpenRoutes>routes.routeQueue.length ? (
              <Link href="/routes" className="mt-3 inline-block text-sm font-semibold text-emerald-800 underline underline-offset-2">
                {tr("Review remaining due open routes", "راجع بقية الجولات المستحقة المفتوحة")}
              </Link>
            ) : null}
          </>
        )}
      </div>
      <p className="border-t border-slate-100 px-4 py-3 text-xs leading-5 text-slate-600 sm:px-5">
        {tr("Read-only management leads. Physical stock returns, machine-stop commits and cash reconciliations require their existing authorized workflows.",
          "مؤشرات للمتابعة فقط. تتطلب إعادة المخزون وإغلاق المواقع وتسوية النقد الإجراءات المعتمدة الحالية.")}
      </p>
    </section>
  );
}
