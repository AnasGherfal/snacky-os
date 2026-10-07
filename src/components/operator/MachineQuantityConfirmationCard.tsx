"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import {
  buildMachineQuantityRows,
  machineQuantityConfirmationKey,
  machineQuantityEvidenceMatches,
  machineQuantityEvidenceReady,
  type MachineQuantityRow,
  type MachineQuantitySourceItem,
  type MachineQuantityVerificationStatus,
} from "@/lib/machine-quantity-confirmation";

export function MachineQuantityConfirmationCard({
  routeId,
  stopId,
  items,
  completed,
  onStateChange,
}: {
  routeId: string;
  stopId: string;
  machineId: string;
  items: MachineQuantitySourceItem[];
  completed?: boolean;
  onStateChange?: (state: { installed: boolean; ready: boolean }) => void;
}) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const onStateChangeRef = useRef(onStateChange);
  const rows = useMemo(() => buildMachineQuantityRows(items), [items]);
  const currentKey = useMemo(() => machineQuantityConfirmationKey(rows), [rows]);

  const [installed, setInstalled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<MachineQuantityVerificationStatus | null>(null);
  const [savedRows, setSavedRows] = useState<MachineQuantityRow[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState("");
  const [autoSyncEligible, setAutoSyncEligible] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [offlineNote, setOfflineNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const savedMatches = savedKey === currentKey || machineQuantityEvidenceMatches(savedRows, rows);
  const ready = rows.length === 0 || Boolean(installed && savedMatches && machineQuantityEvidenceReady(status));
  const pending = ready && (status === "xy_sync_pending" || status === "offline_pending");
  const synced = ready && status === "xy_api_verified";

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    let active = true;
    fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => ({ response, payload: await response.json().catch(() => null) }))
      .then(({ response, payload }) => {
        if (!active) return;
        const nextInstalled = payload?.installed !== false;
        const confirmation = response.ok ? payload?.confirmation : null;
        setInstalled(nextInstalled);
        setSavedKey(String(confirmation?.confirmation_key ?? "") || null);
        setStatus((String(confirmation?.verification_status ?? "") || null) as MachineQuantityVerificationStatus | null);
        setSavedRows(Array.isArray(confirmation?.quantity_rows) ? confirmation.quantity_rows : []);
        setOfflineNote(String(confirmation?.offline_reason ?? ""));
        setSavedAt(confirmation?.submitted_at ?? confirmation?.confirmed_at ?? null);
        setLastSyncError(String(confirmation?.last_sync_error ?? ""));
        setAutoSyncEligible(confirmation?.auto_sync_eligible === true);
      })
      .catch(() => {
        if (!active) return;
        setInstalled(false);
      })
      .finally(() => active && setLoaded(true));
    return () => { active = false; };
  }, [routeId, stopId]);

  useEffect(() => {
    onStateChangeRef.current?.({ installed, ready });
  }, [installed, ready]);

  function filledItemsPayload() {
    return items.map((item) => ({ productId: item.productId, quantity: item.filledQty }));
  }

  function applyConfirmation(payload: any) {
    const confirmation = payload?.confirmation;
    const nextKey = String(confirmation?.confirmation_key ?? "");
    const nextRows = Array.isArray(confirmation?.quantity_rows) ? confirmation.quantity_rows as MachineQuantityRow[] : [];
    if (!nextKey || (nextKey !== currentKey && !machineQuantityEvidenceMatches(nextRows, rows))) {
      throw new Error(tr(
        "The refill quantities changed before they were saved. Review the refill and update XY again.",
        "تغيرت كميات التعبئة قبل حفظها. راجع التعبئة وحدّث XY مرة أخرى.",
      ));
    }
    setInstalled(true);
    setSavedKey(nextKey);
    setStatus(String(confirmation?.verification_status ?? "") as MachineQuantityVerificationStatus);
    setSavedRows(nextRows);
    setOfflineNote(String(confirmation?.offline_reason ?? ""));
    setLastSyncError(String(confirmation?.last_sync_error ?? payload?.syncResult?.message ?? ""));
    setAutoSyncEligible(confirmation?.auto_sync_eligible === true);
    setSavedAt(confirmation?.submitted_at ?? confirmation?.confirmed_at ?? new Date().toISOString());
    setShowOffline(false);
    onStateChangeRef.current?.({ installed: true, ready: true });
  }

  async function saveMode(mode: "xy_api" | "machine_offline") {
    const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        filledItems: filledItemsPayload(),
        offlineNote: mode === "machine_offline" ? offlineNote : "",
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || tr("Could not save the machine quantities.", "تعذر حفظ كميات الجهاز."));
    }
    applyConfirmation(payload);
  }

  async function sendToXy() {
    setSaving(true);
    setError("");
    try {
      await saveMode("xy_api");
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : tr("Could not update XY from Snacky.", "تعذر تحديث XY من سناكي."));
    } finally {
      setSaving(false);
    }
  }

  async function retryPending() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "retry_pending" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || tr("Could not retry XY.", "تعذر إعادة محاولة XY."));
      }
      applyConfirmation(payload);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : tr("Could not retry XY.", "تعذر إعادة محاولة XY."));
    } finally {
      setSaving(false);
    }
  }

  async function saveOffline() {
    setSaving(true);
    setError("");
    try {
      await saveMode("machine_offline");
    } catch (offlineError) {
      setError(offlineError instanceof Error ? offlineError.message : tr("Could not save the power-off refill.", "تعذر حفظ التعبئة أثناء انقطاع الكهرباء."));
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return (
      <section id="machine-quantity-confirmation" className="rounded-xl border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">{tr("Machine quantities", "كميات الجهاز")}</h2>
        <p className="mt-1 text-sm text-slate-600">{tr("No filled selections need an XY quantity update.", "لا توجد خانات معبأة تحتاج إلى تحديث كمياتها في XY.")}</p>
      </section>
    );
  }

  const tone = pending
    ? "border-amber-300 bg-amber-50"
    : ready
      ? "border-emerald-300 bg-emerald-50"
      : "border-slate-300 bg-slate-50";

  return (
    <section id="machine-quantity-confirmation" className={`rounded-xl border-2 p-4 md:p-6 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">{tr("XY inventory", "مخزون XY")}</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{tr("Send refill to machine", "إرسال التعبئة إلى الجهاز")}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {tr(
              "Snacky OS sends the final lane quantities directly to XY and verifies them. You do not need to open the machine settings or take screenshots.",
              "يرسل Snacky OS الكميات النهائية للخانات مباشرة إلى XY ويتحقق منها. لا تحتاج إلى فتح إعدادات الجهاز أو أخذ صور شاشة.",
            )}
          </p>
        </div>
        <span className={pending
          ? "shrink-0 rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-white"
          : ready
            ? "shrink-0 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white"
            : "shrink-0 rounded-full bg-slate-700 px-3 py-1 text-sm font-semibold text-white"}>
          {pending ? tr("Waiting for XY", "بانتظار XY") : ready ? tr("Saved", "تم الحفظ") : tr("Required", "مطلوب")}
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={`${row.productId}:${row.machineSlotId ?? row.slotCode}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Selection", "الخانة")} {row.slotCode}</div>
              <div className="truncate text-sm font-semibold text-slate-900">{row.productName}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xl font-bold text-slate-950">{row.finalQty}</div>
              <div className="text-xs text-slate-500">{row.previousQty} + {row.addedQty}</div>
            </div>
          </div>
        ))}
      </div>

      {!loaded ? <p className="mt-4 text-sm text-slate-600">{tr("Checking saved XY state...", "جارٍ التحقق من حالة XY المحفوظة...")}</p> : null}

      {loaded && !installed ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-900">
          {tr(
            "The direct XY refill update is not installed in the database yet. Apply the Snacky OS migration before relying on this checkpoint.",
            "تحديث التعبئة المباشر إلى XY غير مثبت في قاعدة البيانات بعد. طبّق تحديث قاعدة بيانات Snacky OS قبل الاعتماد على هذه الخطوة.",
          )}
        </div>
      ) : null}

      {synced ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-3 text-sm font-medium text-emerald-900">
          {tr("Snacky sent these quantities to XY and re-read the machine to verify them.", "أرسل سناكي هذه الكميات إلى XY ثم أعاد قراءة الجهاز للتحقق منها.")}
          {savedAt ? ` · ${new Date(savedAt).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}` : ""}
        </div>
      ) : null}

      {pending ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-950">
          <div className="font-semibold">
            {autoSyncEligible
              ? tr("Refill saved in Snacky OS — waiting for XY", "تم حفظ التعبئة في Snacky OS — بانتظار XY")
              : tr("Legacy power-off record — manual review", "سجل قديم لانقطاع الكهرباء — يحتاج مراجعة يدوية")}
          </div>
          <p className="mt-1 leading-6">
            {autoSyncEligible
              ? tr(
                  "You can finish this stop. Snacky retries this saved refill automatically and only marks it synced after XY confirms the quantities.",
                  "يمكنك إنهاء هذا الموقع. يعيد سناكي محاولة هذه التعبئة المحفوظة تلقائياً ولا يعتبرها متزامنة إلا بعد أن يؤكد XY الكميات.",
                )
              : tr(
                  "This record was created before automatic XY sync. Snacky will not push an old quantity into the current machine automatically.",
                  "تم إنشاء هذا السجل قبل المزامنة التلقائية مع XY. لن يرسل سناكي كمية قديمة إلى الجهاز الحالي تلقائياً.",
                )}
          </p>
          {lastSyncError ? <p className="mt-2 text-xs text-amber-800">{lastSyncError}</p> : null}
          {autoSyncEligible && !completed ? (
            <button type="button" onClick={() => void retryPending()} disabled={saving} className="btn-secondary mt-3 w-full disabled:opacity-50">
              {saving ? tr("Checking XY...", "جارٍ التحقق من XY...") : tr("Retry XY now", "إعادة محاولة XY الآن")}
            </button>
          ) : null}
        </div>
      ) : null}

      {!ready && savedKey && !savedMatches ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm font-medium text-amber-900">
          {tr(
            "The filled quantities changed after the last save. Send the updated refill to XY before finishing.",
            "تغيرت كميات التعبئة بعد آخر حفظ. أرسل التعبئة المحدثة إلى XY قبل الإنهاء.",
          )}
        </div>
      ) : null}

      {!ready && loaded && installed && !completed ? (
        <button type="button" className="btn-primary mt-4 w-full min-h-12" disabled={saving} onClick={() => void sendToXy()}>
          {saving ? tr("Sending to XY...", "جارٍ الإرسال إلى XY...") : tr("Update XY from Snacky", "تحديث XY من سناكي")}
        </button>
      ) : null}

      {!ready ? (
        <div className="mt-4 space-y-4">
          <div className="text-center text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("or", "أو")}</div>
          {!showOffline ? (
            <button type="button" onClick={() => setShowOffline(true)} disabled={saving || completed || !installed} className="btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-50">
              {tr("Machine has no electricity", "لا توجد كهرباء في الجهاز")}
            </button>
          ) : (
            <div className="rounded-xl border border-amber-300 bg-white p-4">
              <div className="text-sm font-semibold text-amber-950">{tr("Record the refill now; sync it when power returns", "سجّل التعبئة الآن وزامنها عند عودة الكهرباء")}</div>
              <p className="mt-1 text-xs leading-5 text-amber-900">
                {tr(
                  "Snacky will keep these exact lane quantities in the pending queue and retry XY automatically.",
                  "سيحتفظ سناكي بهذه الكميات الدقيقة للخانات في قائمة الانتظار وسيعيد محاولة XY تلقائياً.",
                )}
              </p>
              <textarea value={offlineNote} onChange={(event) => setOfflineNote(event.target.value)} maxLength={500} className="field-input mt-3" placeholder={tr("Optional note about the power problem", "ملاحظة اختيارية عن مشكلة الكهرباء")} />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => void saveOffline()} disabled={saving} className="btn-primary flex-1 disabled:opacity-50">
                  {tr("Save refill & continue", "حفظ التعبئة والمتابعة")}
                </button>
                <button type="button" onClick={() => setShowOffline(false)} disabled={saving} className="btn-secondary sm:w-auto">
                  {tr("Cancel", "إلغاء")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {saving ? <p className="mt-3 text-center text-sm font-semibold text-slate-700">{tr("Saving...", "جارٍ الحفظ...")}</p> : null}
      {error ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
    </section>
  );
}
