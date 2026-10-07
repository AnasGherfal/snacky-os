"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import type { MachineQuantityRow } from "@/lib/machine-quantity-confirmation";

export function PendingMachineQuantityUpdateCard({
  routeId,
  stopId,
  machineName,
  machineCode,
  routeDate,
  operatorName,
  offlineReason,
  verificationStatus,
  autoSyncEligible,
  rows,
}: {
  routeId: string;
  stopId: string;
  machineId: string;
  machineName: string;
  machineCode: string | null;
  routeDate: string | null;
  operatorName: string | null;
  offlineReason: string | null;
  verificationStatus: string;
  autoSyncEligible: boolean;
  rows: MachineQuantityRow[];
}) {
  const router = useRouter();
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [saving, setSaving] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const legacyPending = verificationStatus === "offline_pending" && !autoSyncEligible;
  const setupReviewPending = verificationStatus === "xy_sync_pending" && !autoSyncEligible;

  async function retryNow() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "retry_pending" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || tr("Could not retry this XY update.", "تعذر إعادة محاولة تحديث XY."));
      }
      if (payload?.synced === true) {
        setResolved(true);
        setMessage(tr("XY confirmed every saved lane quantity.", "أكد XY كل كميات الخانات المحفوظة."));
      } else {
        setMessage(String(payload?.syncResult?.message ?? tr(
          "Still waiting for XY. Snacky will keep retrying automatically.",
          "ما زلنا بانتظار XY. سيواصل سناكي إعادة المحاولة تلقائياً.",
        )));
      }
      router.refresh();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : tr("Could not retry this XY update.", "تعذر إعادة محاولة تحديث XY."));
    } finally {
      setSaving(false);
    }
  }

  if (resolved) {
    return (
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
        {tr("Machine quantities synced and verified by XY.", "تمت مزامنة كميات الجهاز والتحقق منها عبر XY.")}
      </div>
    );
  }

  return (
    <article className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 md:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">{machineName}</h2>
          <p className="text-xs text-slate-600">{machineCode ?? "-"} · {routeDate ?? "-"}{operatorName ? ` · ${operatorName}` : ""}</p>
        </div>
        <span className="self-start rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">
          {legacyPending
            ? tr("Legacy review", "مراجعة سجل قديم")
            : setupReviewPending
              ? tr("Needs review", "يحتاج مراجعة")
              : tr("Waiting for XY", "بانتظار XY")}
        </span>
      </div>

      {offlineReason ? <p className="mt-3 rounded-lg border border-amber-200 bg-white p-3 text-sm text-amber-950">{offlineReason}</p> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={`${row.productId}:${row.machineSlotId ?? row.slotCode}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-500">{tr("Selection", "الخانة")} {row.slotCode}</div>
              <div className="truncate text-sm text-slate-900">{row.productName}</div>
            </div>
            <div className="text-xl font-bold text-slate-950">{row.finalQty}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-950">
          {legacyPending
            ? tr("Legacy power-off record", "سجل قديم لانقطاع الكهرباء")
            : setupReviewPending
              ? tr("XY setup needs review", "إعداد XY يحتاج مراجعة")
              : tr("Automatic XY retry", "إعادة محاولة XY تلقائياً")}
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          {legacyPending
            ? tr(
                "This refill was saved before automatic XY sync existed. Snacky will not push its old quantity into the current machine automatically.",
                "تم حفظ هذه التعبئة قبل وجود المزامنة التلقائية مع XY. لن يرسل سناكي كميتها القديمة إلى الجهاز الحالي تلقائياً.",
              )
            : setupReviewPending
              ? tr(
                  "Automatic retry is paused because the lane, product mapping, or XY price needs review. Fix the setup, then retry this saved refill.",
                  "تم إيقاف إعادة المحاولة التلقائية لأن الخانة أو ربط المنتج أو سعر XY يحتاج مراجعة. أصلح الإعداد ثم أعد محاولة هذه التعبئة المحفوظة.",
                )
              : tr(
                  "Snacky OS keeps these exact quantities and retries them during the XY sync. No machine-settings entry or screenshot is required.",
                  "يحتفظ Snacky OS بهذه الكميات الدقيقة ويعيد إرسالها أثناء مزامنة XY. لا يلزم الدخول إلى إعدادات الجهاز أو رفع صورة شاشة.",
                )}
        </p>
        {message ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</div> : null}
        {error ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
        {!legacyPending ? (
          <button type="button" onClick={() => void retryNow()} disabled={saving} className="btn-primary mt-3 w-full disabled:opacity-50">
            {saving
              ? tr("Checking XY...", "جارٍ التحقق من XY...")
              : setupReviewPending
                ? tr("Retry after fixing setup", "إعادة المحاولة بعد إصلاح الإعداد")
                : tr("Retry XY now", "إعادة محاولة XY الآن")}
          </button>
        ) : null}
      </div>
    </article>
  );
}
