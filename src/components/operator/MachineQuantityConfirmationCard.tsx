"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import {
  buildMachineQuantityRows,
  machineQuantityConfirmationKey,
  machineQuantityEvidenceReady,
  type MachineQuantityEvidenceFile,
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
  const [installed, setInstalled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<MachineQuantityVerificationStatus | null>(null);
  const [evidenceFiles, setEvidenceFiles] = useState<MachineQuantityEvidenceFile[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [offlineNote, setOfflineNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ready = rows.length === 0 || Boolean(installed && savedKey === currentKey && machineQuantityEvidenceReady(status));
  const ownerPending = ready && status === "offline_pending";

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

  function filledItemsPayload() {
    return items.map((item) => ({ productId: item.productId, quantity: item.filledQty }));
  }

  async function saveMode(mode: "xy_screenshot" | "machine_offline", files: MachineQuantityEvidenceFile[] = []) {
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
    if (!nextKey || nextKey !== currentKey) {
      throw new Error(tr("The refill quantities changed. Upload screenshots for the new quantities.", "تغيرت كميات التعبئة. ارفع صوراً للكميات الجديدة."));
    }
    setInstalled(true);
    setSavedKey(nextKey);
    setStatus(String(confirmation?.verification_status ?? "") as MachineQuantityVerificationStatus);
    setEvidenceFiles(Array.isArray(confirmation?.evidence_files) ? confirmation.evidence_files : []);
    setSavedAt(confirmation?.submitted_at ?? confirmation?.confirmed_at ?? new Date().toISOString());
    setShowOffline(false);
    onStateChangeRef.current?.({ installed: true, ready: true });
  }

  async function uploadScreenshots(selected: File[]) {
    if (!selected.length) return;
    const reusableEvidence = savedKey === currentKey && status === "xy_screenshot_saved" ? evidenceFiles : [];
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
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{tr("Update quantities and save the XY page", "حدّث الكميات واحفظ صفحة XY")}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">{tr("Set the changed selections in the machine, refresh the XY cargo-lane page, then upload screenshot(s) showing the quantities.", "اضبط الخانات المتغيرة في الجهاز، وحدّث صفحة خانات XY، ثم ارفع صورة أو صور شاشة توضح الكميات.")}</p>
        </div>
        <span className={ownerPending ? "shrink-0 rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-white" : ready ? "shrink-0 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white" : "shrink-0 rounded-full bg-slate-700 px-3 py-1 text-sm font-semibold text-white"}>
          {ownerPending ? tr("Owner follow-up", "متابعة المالك") : ready ? tr("Saved", "تم الحفظ") : tr("Required", "مطلوب")}
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
            ? tr("Power-off exception saved. You can finish this stop; the owner must update the machine quantities later.", "تم حفظ استثناء انقطاع الكهرباء. يمكنك إنهاء الموقع، وعلى المالك تحديث كميات الجهاز لاحقاً.")
            : tr(`XY screenshot evidence saved (${evidenceFiles.length}).`, `تم حفظ إثبات صور شاشة XY (${evidenceFiles.length}).`)}
          {savedAt ? ` · ${new Date(savedAt).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}` : ""}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {savedKey && savedKey !== currentKey ? (
            <div className="rounded-lg border border-amber-300 bg-white p-3 text-sm font-medium text-amber-900">
              {tr("The filled quantities changed. Upload new XY screenshots for the updated numbers.", "تغيرت كميات التعبئة. ارفع صور شاشة XY جديدة للأرقام المحدثة.")}
            </div>
          ) : null}
          <label className="block rounded-xl border border-slate-200 bg-white p-4">
            <span className="block text-sm font-semibold text-slate-950">{tr("Upload current XY inventory screenshot(s)", "ارفع صورة أو صور مخزون XY الحالية")}</span>
            <span className="mt-1 block text-xs leading-5 text-slate-600">{tr("Choose the top and bottom screenshots together when the page does not fit in one image. They save immediately.", "اختر صورتي أعلى وأسفل الصفحة معاً إذا لم تظهر الصفحة كاملة في صورة واحدة. سيتم حفظها فوراً.")}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={saving || completed || !installed}
              className="field-input mt-3 bg-white"
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                event.target.value = "";
                void uploadScreenshots(selected);
              }}
            />
          </label>

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
          {saving ? <p className="text-center text-sm font-semibold text-slate-700">{tr("Saving evidence...", "جارٍ حفظ الإثبات...")}</p> : null}
          {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
        </div>
      )}
    </section>
  );
}
