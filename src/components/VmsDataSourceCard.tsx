"use client";

import Link from "next/link";
import { ReactNode } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { KpiLoadWarning, KpiSection } from "@/components/KpiDashboard";
import { StatusBadge } from "@/components/ui";
import {
  activeStockBatches,
  batchDateRangeLabel,
  batchImportedRows,
  batchLastUpdatedAt,
  formatVmsDateTime,
  preferredDetailedSalesBatches,
  sourceFileName,
  vmsCoverageSummary,
  type VmsDashboardBatch,
} from "@/lib/vms-dashboard-source";

export function VmsDataSourceCard({
  batches,
  error,
  title = "Data Source",
  subtitle,
  showSales = true,
  showStock = false,
}: {
  batches: VmsDashboardBatch[];
  error?: string | null;
  title?: string;
  subtitle?: string;
  showSales?: boolean;
  showStock?: boolean;
}) {
  const { locale } = useLanguage();
  const isArabic = locale === "ar";
  const localize = (en: string, ar: string) => (isArabic ? ar : en);

  const salesBatches = showSales ? preferredDetailedSalesBatches(batches) : [];
  const coverage = showSales ? vmsCoverageSummary(salesBatches) : null;
  const stockBatches = showStock ? activeStockBatches(batches) : [];
  const latestStockBatch = stockBatches[0] ?? null;
  const salesMessage = showSales
    ? coverage?.active.length
      ? localize(
        `Using ${salesBatches[0]?.report_type === "monthly_transaction_details" ? "Monthly Transaction Report" : "Detailed Order Details"} from ${coverage.active.length} active file(s)${coverage.start && coverage.end ? ` covering ${coverage.start} to ${coverage.end}` : ""}. Latest: ${sourceFileName(coverage.latest)}.`,
        `يتم استخدام ${salesBatches[0]?.report_type === "monthly_transaction_details" ? "تقرير المعاملات الشهرية" : "تفاصيل الطلبات التفصيلية"} من ${coverage.active.length} ملفاً نشطاً${coverage.start && coverage.end ? ` تغطي ${coverage.start} إلى ${coverage.end}` : ""}. الأحدث: ${sourceFileName(coverage.latest)}.`,
      )
      : localize(
        "Monthly Transaction Report not imported yet.",
        "لم يتم استيراد تقرير المعاملات الشهرية بعد.",
      )
    : null;
  const stockMessage = showStock
    ? latestStockBatch
      ? localize(
        `Refill recommendations are using stock snapshot file ${sourceFileName(latestStockBatch)}${batchLastUpdatedAt(latestStockBatch) ? ` (${formatVmsDateTime(batchLastUpdatedAt(latestStockBatch))})` : ""}.`,
        `تستخدم توصيات التعبئة ملف لقطة المخزون ${sourceFileName(latestStockBatch)}${batchLastUpdatedAt(latestStockBatch) ? ` (${formatVmsDateTime(batchLastUpdatedAt(latestStockBatch))})` : ""}.`,
      )
      : localize(
        "Refill recommendations are using manual planogram/storage fallback until a stock snapshot is imported.",
        "تستخدم توصيات التعبئة بديل المخطط/المخزن اليدوي إلى أن يتم استيراد لقطة مخزون.",
      )
    : null;
  const hasSalesData = Boolean(coverage?.active.length);
  const hasStockData = Boolean(latestStockBatch);
  const salesSourceLabel = coverage?.active.length
    ? (salesBatches[0]?.report_type === "monthly_transaction_details"
      ? localize("Using Monthly Transaction Report", "يتم استخدام تقرير المعاملات الشهرية")
      : localize("Using Detailed Order Details", "يتم استخدام تفاصيل الطلبات التفصيلية"))
    : localize("Monthly Transaction Report not imported yet", "لم يتم استيراد تقرير المعاملات الشهرية بعد");
  const salesFiles = coverage?.active.slice(-3).reverse() ?? [];
  const stockFiles = stockBatches.slice(0, 3);

  return (
    <KpiSection title={title} subtitle={subtitle}>
      <KpiLoadWarning message={error} />

      {showSales ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {localize("Detailed Sales Files", "ملفات المبيعات التفصيلية")}
            </div>
            <StatusBadge status={coverage?.active.length ? "active" : "pending"} label={salesSourceLabel} />
          </div>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <div>
              <div className="font-semibold text-slate-900">{localize("Active files", "الملفات النشطة")}</div>
              <div>{coverage?.active.length ?? 0}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Date range", "نطاق التاريخ")}</div>
              <div>{coverage?.start && coverage?.end ? `${coverage.start} to ${coverage.end}` : "-"}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Latest file", "أحدث ملف")}</div>
              <div>{sourceFileName(coverage?.latest)}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Rows imported", "الصفوف المستوردة")}</div>
              <div>{batchImportedRows(coverage?.latest).toLocaleString("en-US")}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Last updated", "آخر تحديث")}</div>
              <div>{formatVmsDateTime(batchLastUpdatedAt(coverage?.latest))}</div>
            </div>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{salesMessage}</p>
          {salesFiles.length ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {localize("Files Used Now", "الملفات المستخدمة الآن")}
              </div>
              <div className="mt-3 space-y-2">
                {salesFiles.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="font-medium text-slate-900">
                      <Link href={`/vms-import/${batch.id}`} className="link-secondary">
                        {sourceFileName(batch)}
                      </Link>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {batchDateRangeLabel(batch)} | {batchImportedRows(batch).toLocaleString("en-US")} {localize("rows", "صفوف")} | {localize("updated", "تم التحديث")} {formatVmsDateTime(batchLastUpdatedAt(batch))}
                    </div>
                  </div>
                ))}
              </div>
              {coverage && coverage.active.length > salesFiles.length ? (
                <p className="mt-3 text-xs text-slate-500">
                  {localize(
                    `+${coverage.active.length - salesFiles.length} older active detailed file(s) still contributing to dashboard totals.`,
                    `+${coverage.active.length - salesFiles.length} ملف تفصيلي نشط أقدم لا يزال يساهم في إجماليات لوحة التحكم.`,
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          {coverage?.gaps.length ? (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
              {localize(
                `Missing detailed sales periods: ${coverage.gaps.map((gap) => `${gap.start} to ${gap.end}`).join(", ")}.`,
                `فترات المبيعات التفصيلية المفقودة: ${coverage.gaps.map((gap) => `${gap.start} إلى ${gap.end}`).join("، ")}.`,
              )}
            </div>
          ) : null}
          {!hasSalesData ? <p className="mt-3 text-sm text-slate-500">{localize("No detailed sales files are active yet.", "لا توجد ملفات مبيعات تفصيلية نشطة بعد.")}</p> : null}
        </div>
      ) : null}

      {showStock ? (
        <div className={`${showSales ? "mt-4" : ""} rounded-xl border border-slate-200 bg-slate-50 p-4`}>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{localize("Stock Snapshot Files", "ملفات لقطة المخزون")}</div>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="font-semibold text-slate-900">{localize("Snapshot file", "ملف اللقطة")}</div>
              <div>{sourceFileName(latestStockBatch)}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Snapshot time", "وقت اللقطة")}</div>
              <div>{batchDateRangeLabel(latestStockBatch)}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Rows imported", "الصفوف المستوردة")}</div>
              <div>{batchImportedRows(latestStockBatch).toLocaleString("en-US")}</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{localize("Last updated", "آخر تحديث")}</div>
              <div>{formatVmsDateTime(batchLastUpdatedAt(latestStockBatch))}</div>
            </div>
          </div>
          <p className="mt-3 text-sm font-medium text-slate-700">{stockMessage}</p>
          {stockFiles.length ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{localize("Snapshot Files In Use", "ملفات اللقطة المستخدمة")}</div>
              <div className="mt-3 space-y-2">
                {stockFiles.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="font-medium text-slate-900">
                      <Link href={`/vms-import/${batch.id}`} className="link-secondary">
                        {sourceFileName(batch)}
                      </Link>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {batchDateRangeLabel(batch)} | {batchImportedRows(batch).toLocaleString("en-US")} {localize("rows", "صفوف")} | {localize("updated", "تم التحديث")} {formatVmsDateTime(batchLastUpdatedAt(batch))}
                    </div>
                  </div>
                ))}
              </div>
              {stockBatches.length > stockFiles.length ? (
                <p className="mt-3 text-xs text-slate-500">
                  {localize(
                    `+${stockBatches.length - stockFiles.length} older active stock file(s) remain available in VMS Data Sources.`,
                    `+${stockBatches.length - stockFiles.length} ملف مخزون نشط أقدم لا يزال متاحاً في مصادر بيانات VMS.`,
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          {!hasStockData ? <p className="mt-3 text-sm text-slate-500">{localize("No active stock snapshot is available yet.", "لا توجد لقطة مخزون نشطة متاحة بعد.")}</p> : null}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Link href="/vms-import/sources" className="text-sm font-semibold text-amber-700 hover:text-amber-800">
          {localize("Open VMS data sources", "افتح مصادر بيانات VMS")}
        </Link>
      </div>
    </KpiSection>
  );
}
