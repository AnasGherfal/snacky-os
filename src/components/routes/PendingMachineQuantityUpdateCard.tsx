"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import type { MachineQuantityEvidenceFile, MachineQuantityRow } from "@/lib/machine-quantity-confirmation";
import { uploadRefillProofPhoto } from "@/lib/operator-actions";

const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function PendingMachineQuantityUpdateCard({
  routeId,
  stopId,
  machineId,
  machineName,
  machineCode,
  routeDate,
  operatorName,
  offlineReason,
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
  rows: MachineQuantityRow[];
}) {
  const router = useRouter();
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState("");

  function chooseFiles(selected: File[]) {
    setError("");
    if (selected.length < 1 || selected.length > MAX_SCREENSHOTS) {
      setFiles([]);
      setError(tr(`Choose one to ${MAX_SCREENSHOTS} screenshots.`, `اختر من صورة إلى ${MAX_SCREENSHOTS} صور شاشة.`));
      return;
    }
    if (selected.some((file) => !SCREENSHOT_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_SCREENSHOT_BYTES)) {
      setFiles([]);
      setError(tr("Screenshots must be PNG, JPG, or WEBP and under 10MB each.", "يجب أن تكون الصور بصيغة PNG أو JPG أو WEBP وأقل من 10 ميغابايت لكل صورة."));
      return;
    }
    setFiles(selected);
  }

  async function resolveUpdate() {
    if (!files.length) {
      setError(tr("Update the machine, refresh XY, then choose the current screenshot(s).", "حدّث الجهاز وصفحة XY، ثم اختر صور الشاشة الحالية."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const evidenceFiles: MachineQuantityEvidenceFile[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append("routeId", routeId);
        form.append("stopId", stopId);
        form.append("machineId", machineId);
        form.append("photo", file);
        const uploaded = await uploadRefillProofPhoto(form);
        if (uploaded.uploadUnavailable || !uploaded.photoPath) throw new Error(tr("A screenshot could not be uploaded. Try again.", "تعذر رفع إحدى الصور. حاول مرة أخرى."));
        evidenceFiles.push({
          photoUrl: uploaded.photoUrl ?? null,
          photoPath: uploaded.photoPath,
          originalName: uploaded.originalName ?? file.name,
          uploadedAt: new Date().toISOString(),
        });
      }

      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/quantity-confirmation`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "owner_resolved", evidenceFiles }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || tr("Could not close this update.", "تعذر إغلاق هذا التحديث."));
      setResolved(true);
      setFiles([]);
      router.refresh();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : tr("Could not close this update.", "تعذر إغلاق هذا التحديث."));
    } finally {
      setSaving(false);
    }
  }

  if (resolved) {
    return <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">{tr("Machine quantities updated and XY evidence saved.", "تم تحديث كميات الجهاز وحفظ إثبات XY.")}</div>;
  }

  return (
    <article className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 md:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">{machineName}</h2>
          <p className="text-xs text-slate-600">{machineCode ?? "-"} · {routeDate ?? "-"}{operatorName ? ` · ${operatorName}` : ""}</p>
        </div>
        <span className="self-start rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">{tr("Power-off follow-up", "متابعة انقطاع الكهرباء")}</span>
      </div>
      {offlineReason ? <p className="mt-3 rounded-lg border border-amber-200 bg-white p-3 text-sm text-amber-950">{offlineReason}</p> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={`${row.productId}:${row.machineSlotId ?? row.slotCode}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="min-w-0"><div className="text-xs font-semibold text-slate-500">{tr("Selection", "الخانة")} {row.slotCode}</div><div className="truncate text-sm text-slate-900">{row.productName}</div></div>
            <div className="text-xl font-bold text-slate-950">{row.finalQty}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-950">{tr("After electricity returns", "بعد عودة الكهرباء")}</div>
        <p className="mt-1 text-xs leading-5 text-slate-600">{tr("Set the quantities above, refresh the XY cargo-lane page, then upload the current screenshot(s).", "اضبط الكميات أعلاه، وحدّث صفحة خانات XY، ثم ارفع صور الشاشة الحالية.")}</p>
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={saving} className="field-input mt-3" onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))} />
        {files.length ? <div className="mt-2 text-xs text-slate-600">{files.length} {tr("screenshot(s) selected", "صورة شاشة محددة")}</div> : null}
        {error ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
        <button type="button" onClick={() => void resolveUpdate()} disabled={saving} className="btn-primary mt-3 w-full disabled:opacity-50">
          {saving ? tr("Saving...", "جارٍ الحفظ...") : tr("Save XY proof and close follow-up", "احفظ إثبات XY وأغلق المتابعة")}
        </button>
      </div>
    </article>
  );
}
