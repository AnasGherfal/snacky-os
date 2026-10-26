"use client";

import { useCallback, useState } from "react";
import {
  parseOperatorRouteStockFlow,
  type OperatorRouteStockFlow,
  type RouteFlowLine,
} from "@/lib/operator-route-stock-flow";

const otherMovementCount = (row: RouteFlowLine) => (
  row.returnedQty + row.damagedQty + row.soldQty + row.compensatedQty
  + row.machineStorageQty + Math.abs(row.adjustmentQty)
);

/** Inspect already committed route bag movements, without editing inventory.
 * Fetches ONLY when opened or explicitly refreshed, via the existing
 * route-authorized picked-items endpoint used by finalization.
 */
export function RouteBagStockFlow({
  routeId,
  locale,
}: {
  routeId: string;
  locale: "en" | "ar";
}) {
  const ar = locale === "ar";
  const tr = useCallback((en: string, arabic: string) => ar ? arabic : en, [ar]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [flow, setFlow] = useState<OperatorRouteStockFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!routeId || loading) return;
    // Do not preserve stale totals as verified after a failed refresh.
    setLoading(true);
    setError(null);
    setFlow(null);
    setCheckedAt(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/operator/routes/${encodeURIComponent(routeId)}/picked-items`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("source_unavailable");
      const result = parseOperatorRouteStockFlow(payload);
      setFlow(result);
      setCheckedAt(new Date().toISOString());
    } catch {
      setError(tr(
        "Could not verify the latest route stock. Check connection and refresh. No inventory was changed.",
        "تعذر التحقق من مخزون الجولة الحالي. تحقق من الاتصال وأعد التحديث. لم يتغير المخزون.",
      ));
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }, [routeId, loading, tr]);

  const open = () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    // Route inventory can change at every completed stop: refresh each open.
    void refresh();
  };

  return (
    <section aria-labelledby="route-stock-flow-title"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
            {tr("INVENTORY · ROUTE", "المخزون · الجولة")}
          </p>
          <h2 id="route-stock-flow-title" className="mt-1 text-lg font-bold text-slate-950">
            {tr("Picked · Filled · Still in bag", "المستلم · المعبأ · المتبقي في الحقيبة")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            {tr(
              "View committed movements from the existing route records. No second stock entry or confirmation is needed.",
              "اعرض الحركات المعتمدة في سجلات الجولة الحالية. لا حاجة لإدخال المخزون أو تأكيده مرة ثانية.",
            )}
          </p>
        </div>
        <button type="button" onClick={open} aria-expanded={expanded} aria-controls="route-stock-flow-content"
          className="btn-secondary min-h-11 shrink-0">
          {expanded ? tr("Hide details", "إخفاء التفاصيل") : tr("View stock flow", "عرض حركة المخزون")}
        </button>
      </div>

      {expanded ? (
        <div id="route-stock-flow-content" className="space-y-4 border-t border-slate-100 p-3 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              {checkedAt
                ? tr("Checked at", "وقت التحقق") + ": " + new Intl.DateTimeFormat(ar ? "ar-LY" : "en-GB", {
                    timeZone: "Africa/Tripoli", dateStyle: "short", timeStyle: "short",
                  }).format(new Date(checkedAt))
                : tr("Not verified yet", "لم يتم التحقق بعد")}
            </p>
            <button type="button" onClick={() => void refresh()} disabled={loading}
              className="min-h-10 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:opacity-50">
              {loading ? tr("Checking…", "جارٍ التحقق…") : tr("Refresh verified stock", "تحديث المخزون المؤكد")}
            </button>
          </div>

          {loading ? (
            <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {tr("Reading your route's committed inventory movements…", "جارٍ قراءة حركات المخزون المعتمدة لهذه الجولة…")}
            </p>
          ) : null}
          {error ? <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{error}</p> : null}
          {flow?.state === "unverified" ? (
            <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              {tr(
                "Verified bag snapshot unavailable. Do not rely on displayed zero or reconstructed stock; ask a manager to review this route.",
                "لقطة رصيد الحقيبة المؤكدة غير متاحة. لا تعتمد صفراً أو رصيداً معاد الحساب؛ اطلب من الإدارة مراجعة هذه الجولة.",
              )}
            </p>
          ) : null}
          {flow && flow.state !== "unverified" ? (
            <>
              {flow.custodyNeedsReview ? (
                <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  {tr(
                    "This route contains unassigned or other-operator custody. Totals cover the route, not necessarily your personal bag. A manager must review the handoff.",
                    "تحتوي الجولة على مخزون غير مسند أو لدى مشغل آخر. الأرقام تخص الجولة وليست بالضرورة حقيبتك وحدك. يلزم مراجعة الإدارة للتسليم.",
                  )}
                </p>
              ) : null}
              {flow.hasNegativeBalance ? (
                <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                  {tr(
                    "A signed bag balance is negative. This needs inventory review; Snacky will not silently set it to zero.",
                    "يوجد رصيد سالب في الحقيبة ويحتاج مراجعة المخزون. لن يحوله سناكي إلى صفر تلقائياً.",
                  )}
                </p>
              ) : null}
              {flow.state === "balance_only" ? (
                <p role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
                  {tr(
                    "Bag balance is verified, but pickup and fill movement details could not be verified. Those figures are unavailable, not zero.",
                    "رصيد الحقيبة مؤكد، لكن تفاصيل الاستلام والتعبئة لم يتم التحقق منها. هذه الأرقام غير متاحة وليست صفراً.",
                  )}
                </p>
              ) : null}
              <div className="grid grid-cols-3 gap-2 sm:gap-4" aria-label={tr("Route stock totals", "إجمالي مخزون الجولة")}>
                {([
                  [tr("Picked from storage", "المستلم من المخزن"), flow.totalLoaded],
                  [tr("Filled at machines", "المعبأ في الأجهزة"), flow.totalFilled],
                  [tr("Signed bag balance", "رصيد الحقيبة الفعلي"), flow.totalRemaining],
                ] as const).map(([name, count]) => (
                  <div key={name} className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                    <div className="text-xs font-medium leading-5 text-slate-600">{name}</div>
                    <div className="mt-2 text-lg font-bold tabular-nums text-slate-950 sm:text-2xl">
                      {count === null ? tr("—", "—") : count.toLocaleString("en-US")}
                    </div>
                  </div>
                ))}
              </div>
              {flow.state === "detailed" && flow.rows.length > 0 ? (
                <div className="space-y-2">
                  {flow.rows.map(row => (
                    <article key={row.productId} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="break-words text-sm font-semibold text-slate-950">{row.productName}</div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                        {([
                          [tr("Picked", "المستلم"), row.loadedQty],
                          [tr("Filled", "المعبأ"), row.filledQty],
                          [tr("In bag", "في الحقيبة"), row.remainingQty],
                        ] as const).map(([name,count]) => (
                          <div key={name} className="rounded-lg bg-slate-50 px-2 py-2">
                            <span className="block text-xs text-slate-600">{name}</span>
                            <strong className={count < 0 ? "mt-1 block text-base tabular-nums text-rose-800" : "mt-1 block text-base tabular-nums text-slate-950"}>{count}</strong>
                          </div>
                        ))}
                      </div>
                      {otherMovementCount(row) > 0 || row.machineReturnQty > 0 ? (
                        <p className="mt-2 text-xs leading-5 text-slate-600">
                          {tr("Other recorded movements", "حركات مسجلة أخرى")}:{" "}
                          {[
                            row.returnedQty > 0 && tr(`Returned to storage ${row.returnedQty}`, `أُعيد للمخزن ${row.returnedQty}`),
                            row.damagedQty > 0 && tr(`Damaged ${row.damagedQty}`, `تالف ${row.damagedQty}`),
                            row.soldQty > 0 && tr(`Manual sales ${row.soldQty}`, `بيع يدوي ${row.soldQty}`),
                            row.compensatedQty > 0 && tr(`Compensated ${row.compensatedQty}`, `تعويض ${row.compensatedQty}`),
                            row.machineStorageQty > 0 && tr(`Machine storage ${row.machineStorageQty}`, `مخزن الجهاز ${row.machineStorageQty}`),
                            row.machineReturnQty > 0 && tr(`Machine returns ${row.machineReturnQty}`, `إرجاع من الجهاز ${row.machineReturnQty}`),
                            row.adjustmentQty !== 0 && tr(`Adjustments ${row.adjustmentQty}`, `تعديلات ${row.adjustmentQty}`),
                          ].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : flow.balances.length > 0 ? (
                <div className="space-y-2">
                  {flow.balances.map(row => (
                    <div key={row.productId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
                      <span className="min-w-0 break-words font-semibold text-slate-900">{row.productName}</span>
                      <span className={row.remainingQty < 0 ? "font-bold tabular-nums text-rose-800" : "font-bold tabular-nums text-slate-900"}>
                        {row.remainingQty} {tr("signed units", "وحدة محسوبة")}
                      </span>
                    </div>
                  ))}
                </div>
              ) : <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                {tr("No committed route-bag movements are recorded yet.", "لا توجد حركات معتمدة لحقيبة الجولة حتى الآن.")}
              </p>}
              <p className="text-xs leading-5 text-slate-600">
                {tr(
                  "These totals reflect committed records, not unsubmitted stop drafts. Remaining stock is the canonical signed bag balance; it may differ from picked minus filled because of returns, sales and corrections. Count physical leftovers when finishing the route.",
                  "تعكس الأرقام السجلات المعتمدة لا المسودات غير المرسلة. المتبقي هو رصيد الحقيبة الرسمي وقد يختلف عن المستلم ناقص المعبأ بسبب الإرجاع والبيع والتصحيحات. عدّ المتبقي فعلياً عند إنهاء الجولة.",
                )}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
