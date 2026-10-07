"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import {
  buildMachineQuantityRows,
  machineQuantityConfirmationKey,
  machineQuantityEvidenceMatches,
  machineQuantityEvidenceReady,
  type MachineQuantityEvidenceFile,
  type MachineQuantityRow,
  type MachineQuantitySourceItem,
  type MachineQuantityVerificationStatus,
} from "@/lib/machine-quantity-confirmation";
import { uploadRefillProofPhoto } from "@/lib/operator-actions";

const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function MachineQuantityConfirmationCard({
  routeId,
  stopId,
  machineId,
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
  // Older admin-created routes can hold product totals without a lane map.
  // Never guess how many items to write into individual XY lanes.
  const missingExactXyLanes = rows.filter((row) => !row.machineSlotId && ["", "VMS", "VMS item"].includes(row.slotCode));
  const missingOriginalLanePlan = items.some((item) => item.hasExactLanePlan === false && Number(item.filledQty ?? 0) > 0);
  const canSyncDirectlyWithXy = missingExactXyLanes.length === 0 && !missingOriginalLanePlan;
  const [installed, setInstalled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<MachineQuantityVerificationStatus | null>(null);
  const [savedRows, setSavedRows] = useState<MachineQuantityRow[]>([]);
  const [evidenceFiles, setEvidenceFiles] = useState<MachineQuantityEvidenceFile[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [offlineNote, setOfflineNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const attemptedAutoSaveKey = useRef<string | null>(null);
  const savedEvidenceMatches = savedKey === currentKey || machineQuantityEvidenceMatches(savedRows, rows);
  const ready = rows.length === 0 || Boolean(installed && savedEvidenceMatches && machineQuantityEvidenceReady(status));
  const ownerPending = ready && status === "offline_pending";
  const canUploadScreenshots = loaded && installed && !completed && status !== "xy_api_verified";
  const reusableEvidenceCount = savedEvidenceMatches && status === "xy_screenshot_saved" ? evidenceFiles.length : 0;
  const screenshotLimitReached = reusableEvidenceCount >= MAX_SCREENSHOTS;

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
        setEvidenceFiles(Array.isArray(confirmation?.evidence_files) ? confirmation.evidence_files : []);
        setOfflineNote(String(confirmation?.offline_reason ?? ""));
        setSavedAt(confirmation?.submitted_at ?? confirmation?.confirmed_at ?? null);
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

  // Actual product/lane quantities are saved automatically. Screenshot evidence
  // and power-off explanations are optional; they must not block a normal stop.
  useEffect(() => {
    if (!loaded || !installed || completed || ready || saving || rows.length === 0
      || attemptedAutoSaveKey.current === currentKey) return;
    const timer = window.setTimeout(() => {
      attemptedAutoSaveKey.current = currentKey;
      setSaving(true);
      setError("");
      void saveMode("sync_pending")
        .catch((cause) => setError(cause instanceof Error ? cause.message : tr(
          "Could not save the actual quantities yet. Tap Save for later to retry.",
          "تعذر حفظ الكميات الفعلية. اضغط حفظ للمزامنة لاحقاً لإعادة المحاولة.",
        )))
        .finally(() => setSaving(false));
    }, 850);
    return () => window.clearTimeout(timer);
  }, [loaded, installed, completed, ready, saving, rows.length, currentKey]);

  function filledItemsPayload() {
    return items.map((item) => ({ productId: item.productId, quantity: item.filledQty, slotQuantities: item.slotQuantities }));
  }

  async function saveMode(mode: "xy_api" | "xy_screenshot" | "machine_offline" | "sync_pending", files: MachineQuantityEvidenceFile[] = []) {
    const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        filledItems: filledItemsPayload(),
        evidenceFiles: files,
        offlineNote: mode === "machine_offline" ? offlineNote : "",
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || tr("Could not save the machine quantity evidence.", "تعذر حفظ إثبات كميات الجهاز."));
    }
    const confirmation = payload?.confirmation;
    const nextKey = String(confirmation?.confirmation_key ?? "");
    const nextRows = Array.isArray(confirmation?.quantity_rows) ? confirmation.quantity_rows as MachineQuantityRow[] : [];
    if (!nextKey || (mode !== "sync_pending" && nextKey !== currentKey && !machineQuantityEvidenceMatches(nextRows, rows))) {
      throw new Error(tr("The refill quantities changed. Upload screenshots for the new quantities.", "تغيرت كميات التعبئة. ارفع صوراً للكميات الجديدة."));
    }
    setInstalled(true);
    setSavedKey(nextKey);
    setStatus(String(confirmation?.verification_status ?? "") as MachineQuantityVerificationStatus);
    setSavedRows(nextRows);
    setEvidenceFiles(Array.isArray(confirmation?.evidence_files) ? confirmation.evidence_files : []);
    setSavedAt(confirmation?.submitted_at ?? confirmation?.confirmed_at ?? new Date().toISOString());
    setShowOffline(false);
    onStateChangeRef.current?.({ installed: true, ready: true });
  }

  async function uploadScreenshots(selected: File[]) {
    if (!selected.length) return;
    const reusableEvidence = savedEvidenceMatches && status === "xy_screenshot_saved" ? evidenceFiles : [];
    if (reusableEvidence.length + selected.length > MAX_SCREENSHOTS) {
      setError(tr(`Upload no more than ${MAX_SCREENSHOTS} screenshots.`, `ارفع بحد أقصى ${MAX_SCREENSHOTS} صور شاشة.`));
      return;
    }
    const invalid = selected.find((file) => !SCREENSHOT_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_SCREENSHOT_BYTES);
    if (invalid) {
      setError(tr("Screenshots must be PNG, JPG, or WEBP and under 10MB each.", "يجب أن تكون صور الشاشة بصيغة PNG أو JPG أو WEBP وأقل من 10 ميغابايت لكل صورة."));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const uploadedFiles: MachineQuantityEvidenceFile[] = [];
      for (const file of selected) {
        const form = new FormData();
        form.append("routeId", routeId);
        form.append("stopId", stopId);
        form.append("machineId", machineId);
        form.append("photo", file);
        const uploaded = await uploadRefillProofPhoto(form);
        if (uploaded.uploadUnavailable || !uploaded.photoPath) {
          throw new Error(tr("A screenshot could not be uploaded. Select it again and retry.", "تعذر رفع إحدى صور الشاشة. اخترها مرة أخرى وحاول من جديد."));
        }
        uploadedFiles.push({
          photoUrl: uploaded.photoUrl ?? null,
          photoPath: uploaded.photoPath,
          originalName: uploaded.originalName ?? file.name,
          uploadedAt: new Date().toISOString(),
        });
        const savedFiles = [...reusableEvidence, ...uploadedFiles].filter((savedFile, index, all) => (
          all.findIndex((candidate) => candidate.photoPath === savedFile.photoPath) === index
        ));
        // Save after each upload so evidence already captured survives an app close
        // or connection failure while a second screenshot is uploading.
        await saveMode("xy_screenshot", savedFiles);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : tr("Could not save the XY screenshots.", "تعذر حفظ صور شاشة XY."));
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
      setError(offlineError instanceof Error ? offlineError.message : tr("Could not save the power-off follow-up.", "تعذر حفظ متابعة انقطاع الكهرباء."));
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return (
      <section id="machine-quantity-confirmation" className="rounded-xl border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">{tr("Machine quantities", "كميات الجهاز")}</h2>
        <p className="mt-1 text-sm text-slate-600">{tr("No filled selections need a machine-system update.", "لا توجد خانات معبأة تحتاج إلى تحديث في نظام الجهاز.")}</p>
      </section>
    );
  }

  const tone = ownerPending
    ? "border-amber-300 bg-amber-50"
    : ready
      ? "border-emerald-300 bg-emerald-50"
      : "border-slate-300 bg-slate-50";

  return (
    <section id="machine-quantity-confirmation" className={`rounded-xl border-2 p-4 md:p-6 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">{tr("Machine-system inventory", "مخزون نظام الجهاز")}</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{tr("Update machine quantities", "حدّث كميات الجهاز")}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">{tr("After physically filling the machine, Snacky writes the confirmed lane quantities into XY and reads them back to verify the result. Screenshots remain available as a fallback.", "بعد تعبئة الجهاز فعلياً، يرسل سناكي كميات الخانات المؤكدة إلى XY ثم يقرأها من جديد للتحقق. تبقى صور الشاشة خياراً احتياطياً.")}</p>
        </div>
        <span className={ownerPending ? "shrink-0 rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-white" : ready ? "shrink-0 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white" : "shrink-0 rounded-full bg-slate-700 px-3 py-1 text-sm font-semibold text-white"}>
          {ownerPending ? tr("Sync pending", "مزامنة معلقة") : ready ? tr("Saved", "تم الحفظ") : tr("Saving quantities", "حفظ الكميات")}
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

      {!loaded ? <p className="mt-4 text-sm text-slate-600">{tr("Checking saved evidence...", "جارٍ التحقق من الإثبات المحفوظ...")}</p> : null}
      {loaded && !installed ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-900">
          {tr("Machine quantity evidence is not installed yet. The route remains usable until the database update is applied.", "إثبات كميات الجهاز غير مثبت بعد. ستظل الجولة قابلة للاستخدام إلى أن يتم تطبيق تحديث قاعدة البيانات.")}
        </div>
      ) : null}

      {ready ? (
        <div className={`mt-4 rounded-lg border bg-white p-3 text-sm font-medium ${ownerPending ? "border-amber-300 text-amber-950" : "border-emerald-200 text-emerald-900"}`}>
          {ownerPending
            ? tr("Actual quantities saved. This stop can be finished; XY synchronization is pending. Photos are optional.", "تم حفظ الكميات الفعلية. يمكنك إنهاء الموقع وستتم متابعة تحديث XY. الصور اختيارية.")
            : status==="xy_api_verified"
              ? tr("Updated and verified directly with XY.", "تم تحديث الكميات والتحقق منها مباشرة عبر XY.")
              : tr(`XY screenshot evidence saved (${evidenceFiles.length}).`, `تم حفظ إثبات صور شاشة XY (${evidenceFiles.length}).`)}
          {savedAt ? ` · ${new Date(savedAt).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}` : ""}
        </div>
      ) : null}

      {!ready && savedKey && !savedEvidenceMatches && status !== "offline_pending" ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm font-medium text-amber-900">
          {tr("The filled quantities changed. Upload new XY screenshots for the updated numbers.", "تغيرت كميات التعبئة. ارفع صور شاشة XY جديدة للأرقام المحدثة.")}
        </div>
      ) : null}

      {!ready && loaded && installed && !completed && !canSyncDirectlyWithXy ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          <strong>{tr("This route has no exact XY lane assignments.", "هذه الجولة لا تحتوي على تعيينات دقيقة لخانات XY.")}</strong>{" "}
          {tr("It was created with product-level quantities only. Snacky cannot safely split those totals between vending lanes automatically. After updating the machine's real lane quantities, upload current XY screenshots below to confirm this stop. Do not choose the power-off option unless the machine really has no electricity.", "أُنشئت هذه الجولة بكميات إجمالية لكل منتج فقط، ولا يمكن لسناكي توزيعها بأمان على خانات الجهاز دون معرفة الكميات الحقيقية. بعد تحديث كميات الخانات الفعلية في الجهاز، ارفع صور شاشة XY الحالية أدناه لإثبات التعبئة. لا تستخدم خيار انقطاع الكهرباء إلا إذا كان الجهاز دون كهرباء فعلاً.")}
        </div>
      ) : null}
      {!ready && loaded && installed && !completed && canSyncDirectlyWithXy ? (
        <button type="button" className="btn-primary mt-4 w-full" disabled={saving} onClick={() => {setSaving(true);setError("");void saveMode("xy_api").catch((verifyError) => setError(verifyError instanceof Error ? verifyError.message : tr("Could not update and verify quantities with XY.", "تعذر تحديث الكميات والتحقق منها عبر XY."))).finally(() => setSaving(false));}}>
          {saving ? tr("Updating XY...", "جارٍ تحديث XY...") : tr("Update & verify with XY", "حدّث وتحقق عبر XY")}
        </button>
      ) : null}

      {loaded && installed && !completed && !ready && !saving ? (
        <button type="button" className="btn-secondary mt-3 w-full" onClick={() => {
          attemptedAutoSaveKey.current = null;
          setSaving(true);
          setError("");
          void saveMode("sync_pending")
            .catch((cause) => setError(cause instanceof Error ? cause.message : tr("Could not save quantities.", "تعذر حفظ الكميات.")))
            .finally(() => setSaving(false));
        }}>
          {tr("Save quantities & continue (sync later)", "احفظ الكميات وتابع (المزامنة لاحقاً)")}
        </button>
      ) : null}
      <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">{tr("Optional: XY photos or connection/power note", "اختياري: صور XY أو ملاحظة الاتصال والكهرباء")}</summary>
      {canUploadScreenshots ? (
        <label className="mt-4 block rounded-xl border border-slate-200 bg-white p-4">
          <span className="block text-sm font-semibold text-slate-950">
            {ready ? tr("Add more XY screenshots", "أضف صور شاشة XY أخرى") : tr("Upload current XY inventory screenshot(s)", "ارفع صورة أو صور مخزون XY الحالية")}
          </span>
          <span className="mt-1 block text-xs leading-5 text-slate-600">
            {tr(`Select several photos together, or add them one at a time. Up to ${MAX_SCREENSHOTS} photos are saved.`, `اختر عدة صور معاً أو أضفها واحدة تلو الأخرى. يمكن حفظ حتى ${MAX_SCREENSHOTS} صور.`)}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={saving || screenshotLimitReached}
            className="field-input mt-3 bg-white"
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadScreenshots(selected);
            }}
          />
          {reusableEvidenceCount > 0 ? (
            <span className="mt-2 block text-xs font-medium text-slate-600">
              {tr(`${reusableEvidenceCount} of ${MAX_SCREENSHOTS} photos saved.`, `تم حفظ ${reusableEvidenceCount} من ${MAX_SCREENSHOTS} صور.`)}
            </span>
          ) : null}
        </label>
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
              <div className="text-sm font-semibold text-amber-950">{tr("Finish the stop without blocking the route", "إنهاء الموقع دون تعطيل الجولة")}</div>
              <p className="mt-1 text-xs leading-5 text-amber-900">{tr("Snacky will add this machine to the owner's pending quantity-update list.", "سيضيف سناكي هذا الجهاز إلى قائمة تحديث الكميات المعلقة لدى المالك.")}</p>
              <textarea value={offlineNote} onChange={(event) => setOfflineNote(event.target.value)} maxLength={500} className="field-input mt-3" placeholder={tr("Optional note about the power problem", "ملاحظة اختيارية عن مشكلة الكهرباء")} />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => void saveOffline()} disabled={saving} className="btn-primary flex-1 disabled:opacity-50">
                  {tr("Save as power off and continue", "احفظ كحالة انقطاع كهرباء وتابع")}
                </button>
                <button type="button" onClick={() => setShowOffline(false)} disabled={saving} className="btn-secondary sm:w-auto">
                  {tr("Cancel", "إلغاء")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      </details>
      {saving ? <p className="mt-3 text-center text-sm font-semibold text-slate-700">{tr("Saving evidence...", "جارٍ حفظ الإثبات...")}</p> : null}
      {error ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
    </section>
  );
}
