"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";

type ScopeType = "route" | "machine" | "operator";

type CompensationRecord = {
  id: string;
  routeId: string;
  routeStopId: string;
  machineId: string;
  operatorId: string | null;
  productId: string;
  productName: string;
  quantity: number;
  claimType: string;
  claimedAmountLyd: number | null;
  notes: string | null;
  compensatedAt: string;
  inventoryMovementId: string | null;
  inventoryCostLyd: number | null;
  needsReview: boolean;
  reviewReason: string | null;
  machine: { id: string; label: string };
  route: { id: string; date: string | null; status: string | null };
  operator: { id: string; name: string } | null;
};

type CompensationPayload = {
  success: boolean;
  installed?: boolean;
  error?: string;
  scope?: { type: ScopeType; id: string; label: string };
  records?: CompensationRecord[];
  totals?: {
    entries: number;
    units: number;
    knownInventoryCostLyd: number;
    knownInventoryCostRecords: number;
    inventoryValueComplete: boolean;
    claimedAmountLyd: number;
    claimedAmountRecords: number;
    needsReview: number;
  } | null;
};

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function pageScope(pathname: string | null) {
  if (!pathname) return null;
  const candidates: Array<{ type: ScopeType; match: RegExpMatchArray | null }> = [
    { type: "route", match: pathname.match(/^\/(?:operator\/)?routes\/([^/]+)\/?$/) },
    { type: "machine", match: pathname.match(/^\/machines\/([^/]+)\/?$/) },
    { type: "operator", match: pathname.match(/^\/team\/([^/]+)\/?$/) },
  ];
  const candidate = candidates.find((item) => item.match?.[1] && isUuid(item.match[1]));
  return candidate?.match?.[1] ? { type: candidate.type, id: candidate.match[1] } : null;
}

function claimLabel(claimType: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    paid_no_product: ["Paid but product did not dispense", "دفع ولم يخرج المنتج"],
    product_jammed: ["Product jammed", "المنتج عالق"],
    wrong_product: ["Wrong product dispensed", "خرج منتج خاطئ"],
    dispensing_damage: ["Product damaged during dispensing", "تلف المنتج أثناء خروجه"],
    previous_unresolved_issue: ["Previous unresolved vending issue", "مشكلة بيع سابقة لم تُحل"],
    damaged_or_stuck: ["Product damaged or stuck", "المنتج تالف أو عالق"],
    other: ["Other", "سبب آخر"],
  };
  const label = labels[claimType] ?? [claimType.replaceAll("_", " "), claimType.replaceAll("_", " ")];
  return locale === "ar" ? label[1] : label[0];
}

function money(value: number, locale: string) {
  return `${Number(value ?? 0).toLocaleString(locale === "ar" ? "ar-LY" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} LYD`;
}

function recordTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === "ar" ? "ar-LY" : "en-US");
}

function routeLabel(record: CompensationRecord, locale: string) {
  if (record.route.date) return locale === "ar" ? `جولة ${record.route.date}` : `Route ${record.route.date}`;
  return locale === "ar" ? "الجولة" : "Route";
}

export function CustomerCompensationHistoryPanel() {
  const pathname = usePathname();
  const scope = pageScope(pathname);
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [payload, setPayload] = useState<CompensationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!scope) {
      setPayload(null);
      setError("");
      return;
    }

    const controller = new AbortController();
    const parameter = scope.type === "route" ? "routeId" : scope.type === "machine" ? "machineId" : "operatorId";
    setLoading(true);
    setError("");
    fetch(`/api/compensations/history?${parameter}=${encodeURIComponent(scope.id)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const nextPayload = await response.json().catch(() => null) as CompensationPayload | null;
        if (!response.ok || !nextPayload?.success) {
          throw new Error(nextPayload?.error || tr("Could not load customer compensation history.", "تعذر تحميل سجل تعويضات العملاء."));
        }
        setPayload(nextPayload);
      })
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : tr("Could not load customer compensation history.", "تعذر تحميل سجل تعويضات العملاء."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [scope?.id, scope?.type, locale]);

  const records = payload?.records ?? [];
  const operatorRouteView = Boolean(pathname?.startsWith("/operator/routes/"));
  const visibleRecords = records.slice(0, 200);
  const groups = useMemo(() => {
    if (!scope) return [];
    const grouped = new Map<string, { label: string; href: string | null; records: CompensationRecord[] }>();

    records.forEach((record) => {
      let key = "all";
      let label = tr("All compensation", "كل التعويضات");
      let href: string | null = null;

      if (scope.type === "route") {
        key = record.machine.id;
        label = record.machine.label;
        href = operatorRouteView ? null : `/machines/${record.machine.id}`;
      } else if (scope.type === "machine") {
        key = record.route.id;
        label = routeLabel(record, locale);
        href = `/routes/${record.route.id}`;
      } else {
        key = record.machine.id;
        label = record.machine.label;
        href = null;
      }

      const current = grouped.get(key) ?? { label, href, records: [] };
      current.records.push(record);
      grouped.set(key, current);
    });

    return Array.from(grouped.entries())
      .map(([key, group]) => ({
        key,
        ...group,
        entries: group.records.length,
        units: group.records.reduce((sum, record) => sum + record.quantity, 0),
        knownCost: group.records.reduce((sum, record) => sum + Number(record.inventoryCostLyd ?? 0), 0),
        costComplete: group.records.every((record) => record.inventoryCostLyd !== null),
        needsReview: group.records.filter((record) => record.needsReview).length,
      }))
      .sort((left, right) => right.units - left.units || left.label.localeCompare(right.label));
  }, [records, scope?.id, scope?.type, locale, operatorRouteView]);

  if (!scope) return null;

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {tr("Customer service inventory", "مخزون خدمة العملاء")}
          </div>
          <h2 className="mt-1 text-xl font-bold text-slate-950">{tr("Customer compensation", "تعويضات العملاء")}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            {tr(
              "Replacement products given for vending problems. These records are inventory usage only: they are not sales, revenue, damage, or operator consumption.",
              "المنتجات البديلة التي تم إعطاؤها بسبب مشاكل البيع. هذه السجلات استخدام للمخزون فقط، وليست مبيعات أو إيراداً أو تلفاً أو استهلاكاً للمشغل.",
            )}
          </p>
        </div>
        {payload?.scope?.label ? (
          <span className="w-fit rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{payload.scope.label}</span>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-slate-100" />)}
        </div>
      ) : null}

      {error ? (
        <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{error}</div>
      ) : null}

      {!loading && !error && payload?.installed === false ? (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          {tr(
            "Customer compensation database migrations have not been applied to Supabase yet.",
            "لم يتم تطبيق تحديثات قاعدة بيانات تعويضات العملاء على Supabase بعد.",
          )}
        </div>
      ) : null}

      {!loading && !error && payload?.installed !== false && payload?.totals ? (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric label={tr("Compensation entries", "سجلات التعويض")} value={payload.totals.entries} />
            <Metric label={tr("Units given", "الوحدات المعطاة")} value={payload.totals.units} />
            <Metric
              label={tr("Known inventory cost", "تكلفة المخزون المعروفة")}
              value={money(payload.totals.knownInventoryCostLyd, locale)}
              note={!payload.totals.inventoryValueComplete ? tr("Some movement costs are missing", "بعض تكاليف الحركات غير متوفرة") : undefined}
            />
            <Metric
              label={tr("Customer-reported loss", "المبلغ المفقود حسب العميل")}
              value={money(payload.totals.claimedAmountLyd, locale)}
              note={payload.totals.claimedAmountRecords !== payload.totals.entries ? tr("Only entered claims", "للشكاوى التي أُدخل مبلغها فقط") : undefined}
            />
            <Metric
              label={tr("Needs inventory review", "يحتاج مراجعة مخزون")}
              value={payload.totals.needsReview}
              tone={payload.totals.needsReview > 0 ? "warn" : "neutral"}
            />
          </div>

          {!records.length ? (
            <div className="mt-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
              <div className="font-semibold text-slate-900">{tr("No customer compensation recorded", "لا توجد تعويضات عملاء مسجلة")}</div>
              <p className="mt-1 text-sm text-slate-500">
                {tr("Compensation recorded at machine stops will appear here.", "ستظهر هنا التعويضات المسجلة أثناء تعبئة الأجهزة.")}
              </p>
            </div>
          ) : (
            <>
              <div className="mt-6">
                <h3 className="text-base font-semibold text-slate-900">
                  {scope.type === "route"
                    ? tr("Route compensation by machine", "تعويضات الجولة حسب الجهاز")
                    : scope.type === "machine"
                      ? tr("Machine compensation by route", "تعويضات الجهاز حسب الجولة")
                      : tr("Operator compensation by machine", "تعويضات المشغل حسب الجهاز")}
                </h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {groups.map((group) => (
                    <div key={group.key} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        {group.href ? <Link className="font-semibold text-slate-900 hover:underline" href={group.href}>{group.label}</Link> : <div className="font-semibold text-slate-900">{group.label}</div>}
                        {group.needsReview ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">{group.needsReview} {tr("review", "مراجعة")}</span> : null}
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                        <div><div className="text-xs text-slate-500">{tr("Entries", "السجلات")}</div><div className="font-semibold">{group.entries}</div></div>
                        <div><div className="text-xs text-slate-500">{tr("Units", "الوحدات")}</div><div className="font-semibold">{group.units}</div></div>
                        <div><div className="text-xs text-slate-500">{tr("Cost", "التكلفة")}</div><div className="font-semibold">{money(group.knownCost, locale)}</div></div>
                      </div>
                      {!group.costComplete ? <div className="mt-2 text-xs text-amber-700">{tr("Known cost only", "التكلفة المعروفة فقط")}</div> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-6 border-t border-slate-200 pt-5">
                <h3 className="text-base font-semibold text-slate-900">{tr("Compensation history", "سجل التعويضات")}</h3>
                <div className="mt-3 space-y-3">
                  {visibleRecords.map((record) => {
                    const routeHref = scope.type === "operator" ? `/operator/routes/${record.route.id}` : `/routes/${record.route.id}`;
                    return (
                      <article key={record.id} className="rounded-lg border border-slate-200 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="font-semibold text-slate-950">{record.productName} × {record.quantity}</div>
                            <div className="mt-1 text-sm text-slate-600">{claimLabel(record.claimType, locale)}</div>
                          </div>
                          <div className="text-xs text-slate-500">{recordTime(record.compensatedAt, locale)}</div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600">
                          {scope.type === "route" ? (operatorRouteView ? <span>{record.machine.label}</span> : <Link className="hover:underline" href={`/machines/${record.machine.id}`}>{record.machine.label}</Link>) : scope.type === "operator" ? <span>{record.machine.label}</span> : null}
                          {scope.type !== "route" ? <Link className="hover:underline" href={routeHref}>{routeLabel(record, locale)}</Link> : null}
                          {record.operator ? <span>{tr("Operator", "المشغل")}: {record.operator.name}</span> : null}
                          <span>{tr("Inventory cost", "تكلفة المخزون")}: {record.inventoryCostLyd === null ? "—" : money(record.inventoryCostLyd, locale)}</span>
                          {record.claimedAmountLyd !== null ? <span>{tr("Claimed loss", "المبلغ المفقود حسب العميل")}: {money(record.claimedAmountLyd, locale)}</span> : null}
                        </div>
                        {record.notes ? <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{record.notes}</p> : null}
                        {record.needsReview ? (
                          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                            {tr("Inventory review needed", "يحتاج مراجعة للمخزون")}{record.reviewReason ? ` · ${record.reviewReason}` : ""}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
                {records.length > visibleRecords.length ? (
                  <p className="mt-3 text-xs text-slate-500">
                    {tr("Showing the 200 most recent entries. Totals and grouped summaries include all loaded records.", "يتم عرض أحدث 200 سجل. الإجماليات والملخصات المجمعة تشمل كل السجلات المحملة.")}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  note?: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className={tone === "warn" ? "rounded-lg border border-amber-200 bg-amber-50 p-4" : "rounded-lg border border-slate-200 bg-slate-50 p-4"}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-950">{value}</div>
      {note ? <div className="mt-1 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}
