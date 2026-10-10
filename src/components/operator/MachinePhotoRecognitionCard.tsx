"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { canApplyPhotoChange, type PhotoSuggestion } from "@/lib/xy-photo-recognition";

type RowState = { reviewed: boolean; oldAccounted: boolean; actualQty: string; selectedProductId: string };
type ScanResult = {
  ok?: boolean;
  error?: string;
  photoQuality?: "good" | "partial" | "unreadable";
  suggestions?: PhotoSuggestion[];
  unreadableSlots?: string[];
  rejectedObservations?: number;
};
type ProductOption = { id: string; name: string };

export function MachinePhotoRecognitionCard({
  routeId, stopId, photoSaved, photoSaving, products, onApplied,
}: {
  routeId: string;
  stopId: string;
  photoSaved: boolean;
  photoSaving: boolean;
  products: ProductOption[];
  onApplied: () => void;
}) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const reset = () => { setScan(null); setRows({}); setApplied({}); setError(""); };
    window.addEventListener("snacky:machine-photo-persisted", reset);
    return () => window.removeEventListener("snacky:machine-photo-persisted", reset);
  }, []);

  const suggestions = scan?.suggestions ?? [];
  const changed = suggestions.filter((suggestion) => suggestion.differentFromXy);
  const unchanged = suggestions.filter((suggestion) => !suggestion.differentFromXy);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);

  const patch = (code: string, patchRow: Partial<RowState>) =>
    setRows((current) => ({
      ...current,
      [code]: { ...(current[code] ?? { reviewed: false, oldAccounted: false, actualQty: "", selectedProductId: "" }), ...patchRow },
    }));

  const selected = changed.filter((suggestion) => {
    const state = rows[suggestion.slotCode];
    return !applied[suggestion.slotCode] && state?.reviewed === true;
  });
  const canApply = selected.length > 0 && selected.every((suggestion) => {
    const state = rows[suggestion.slotCode];
    const quantity = state?.actualQty?.trim() === "" ? null : Number(state.actualQty);
    return canApplyPhotoChange({
      suggestion,
      actualQty: quantity,
      operatorReviewed: Boolean(state?.reviewed),
      oldProductAccounted: Boolean(state?.oldAccounted),
    });
  });

  async function scanPhoto() {
    if (!photoSaved || scanning || photoSaving) return;
    setScanning(true);
    setError("");
    setScan(null);
    setApplied({});
    setRows({});
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/xy-photo-detect`, {
        method: "POST", cache: "no-store", headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => null) as ScanResult | null;
      if (!response.ok || body?.ok !== true) throw new Error(body?.error || "Could not recognize products in this photo.");
      setScan(body);
      const nextRows: Record<string, RowState> = {};
      for (const result of body.suggestions ?? []) {
        nextRows[result.slotCode] = {
          reviewed: false, oldAccounted: false, actualQty: "", selectedProductId: result.productId,
        };
      }
      setRows(nextRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Could not analyze image.", "تعذر تحليل الصورة."));
    } finally {
      setScanning(false);
    }
  }

  async function applyConfirmed() {
    if (!canApply || saving) return;
    setSaving(true);
    setError("");
    let succeeded = 0;
    try {
      // Use Snacky's EXISTING guarded XY endpoint only after explicit physical confirmation.
      // No model output is ever dispatched directly to the vending machine.
      for (const suggestion of selected) {
        const state = rows[suggestion.slotCode];
        const qty = Number(state.actualQty);
        setProgress(`${succeeded + 1}/${selected.length} · ${suggestion.slotCode}`);
        const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/xy-slot-product`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            slotCode: suggestion.slotCode,
            productId: state.selectedProductId,
            actualSlotQty: qty,
            physicalChangeConfirmed: true,
            laneDisabledConfirmed: true,
            queueOnOffline: false,
          }),
        });
        const result = await response.json().catch(() => null) as {
          success?: boolean; verified?: boolean; error?: string;
        } | null;
        if (!response.ok || result?.success !== true || result.verified !== true) {
          throw new Error(`${suggestion.slotCode}: ${result?.error || tr("XY has not verified this change; stop and check the machine.", "لم يؤكد XY التغيير؛ راجع الجهاز قبل المتابعة.")}`);
        }
        succeeded++;
        setApplied((current) => ({ ...current, [suggestion.slotCode]: true }));
      }
      setProgress(tr(`${succeeded} XY selections verified`, `تم التحقق من ${succeeded} خانات في XY`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("XY could not complete this change.", "تعذر إكمال التغيير في XY."));
    } finally {
      setSaving(false);
      if (succeeded) onApplied();
    }
  }

  return (
    <section id="machine-photo-recognition" className="overflow-hidden rounded-2xl border-2 border-emerald-200 bg-white shadow-sm">
      <header className="border-b border-emerald-100 bg-emerald-50 p-4 sm:p-5">
        <div className="text-xs font-bold tracking-widest text-emerald-800">SNACKY OS · PHOTO AI</div>
        <h2 className="mt-1 text-lg font-extrabold text-emerald-950">
          {tr("Recognize products from machine photo", "التعرف على المنتجات من صورة الماكينة")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-emerald-900">
          {tr(
            "One machine photo can suggest which product belongs to each visible XY selection. Review changes, enter real physical quantities, then apply confirmed changes to XY.",
            "يمكن لصورة الماكينة اقتراح المنتج الموجود في كل خانة ظاهرة من XY. راجع التغييرات وأدخل الكمية الفعلية ثم طبّق التعديلات المؤكدة على XY.",
          )}
        </p>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        <button type="button" className="btn-primary w-full" onClick={() => void scanPhoto()}
          disabled={!photoSaved || photoSaving || scanning || saving}>
          {scanning ? tr("Analyzing photo…", "جارٍ تحليل الصورة…") : tr("Scan saved machine photo", "فحص صورة الماكينة المحفوظة")}
        </button>
        {!photoSaved ? <p className="text-sm text-amber-800">{tr(
          "Take and save the final machine photo above before using detection.",
          "التقط صورة الماكينة أعلاه واحفظها أولاً قبل استخدام التعرف.",
        )}</p> : null}
        <p className="text-xs leading-5 text-slate-600">{tr(
          "A photo usually shows only the front item, not the true stock depth. AI never guesses quantities, changes prices, or updates XY without your confirmation.",
          "الصورة غالباً تُظهر المنتج الأمامي فقط وليس العدد خلفه. الذكاء الاصطناعي لا يخمّن الكميات ولا يغير الأسعار أو يحدث XY دون تأكيدك.",
        )}</p>

        {scan ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xl font-bold text-emerald-900">{unchanged.length}</div><div className="text-xs text-emerald-800">{tr("Already match XY", "مطابقة لـ XY")}</div></div>
              <div className="rounded-xl bg-amber-50 p-3"><div className="text-xl font-bold text-amber-900">{changed.length}</div><div className="text-xs text-amber-800">{tr("Proposed changes", "تغييرات مقترحة")}</div></div>
              <div className="rounded-xl bg-slate-100 p-3"><div className="text-xl font-bold text-slate-900">{scan.unreadableSlots?.length ?? 0}</div><div className="text-xs text-slate-600">{tr("Not identified", "لم تُعرف")}</div></div>
            </div>
            {scan.photoQuality !== "good" ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {tr("Image is partial or unclear. Retake a straight-on, well-lit picture to identify more selections.", "الصورة ناقصة أو غير واضحة. التقط صورة أمامية واضحة بإضاءة جيدة لرؤية خانات أكثر.")}
            </div> : null}
            {changed.length === 0 ? <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              {tr("No confirmed differences were suggested. Review unrecognized lanes manually; a photo cannot prove every stock quantity.", "لم تُقترح تغييرات واضحة. راجع الخانات غير المعروفة يدوياً؛ الصورة لا تثبت جميع كميات المخزون.")}
            </p> : null}
            {changed.map((suggestion) => {
              const state = rows[suggestion.slotCode];
              const completed = applied[suggestion.slotCode];
              const qty = state?.actualQty?.trim() === "" ? null : Number(state?.actualQty);
              const valid = canApplyPhotoChange({
                suggestion, actualQty: qty, operatorReviewed: Boolean(state?.reviewed),
                oldProductAccounted: Boolean(state?.oldAccounted),
              });
              return (
                <div key={suggestion.slotCode} className={`space-y-3 rounded-xl border p-4 ${completed ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div><span className="font-mono text-base font-extrabold text-slate-950">{suggestion.slotCode}</span>
                      <div className="text-xs text-slate-500">{tr("AI suggests", "الاقتراح")} · {suggestion.productName}</div></div>
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${suggestion.confidence === "high" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
                      {completed ? tr("Verified in XY", "تم التحقق في XY") : suggestion.confidence}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{suggestion.visualEvidence}</p>
                  <p className="text-xs text-slate-700">{tr("Current XY quantity", "الكمية الحالية في XY")}: {suggestion.currentQty ?? "—"} · {tr("Capacity", "السعة")}: {suggestion.capacity ?? "—"}</p>
                  {!completed ? (
                    <>
                      <label className="block text-sm font-semibold text-slate-800">
                        {tr("Correct visible product (confirm AI)", "المنتج الحقيقي الظاهر (راجع اقتراح AI)")}
                        <select className="field-input mt-1" value={state?.selectedProductId || suggestion.productId}
                          onChange={(e) => patch(suggestion.slotCode, { selectedProductId: e.target.value, reviewed: false })}>
                          {!productById.has(suggestion.productId) ? <option value={suggestion.productId}>{suggestion.productName}</option> : null}
                          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                        </select>
                      </label>
                      <label className="block text-sm font-semibold text-slate-800">
                        {tr("Final actual units in this selection (not visible from photo)", "العدد الفعلي النهائي داخل هذه الخانة (لا يمكن معرفته من الصورة)")}
                        <input type="number" min={0} max={suggestion.capacity ?? undefined} step={1} inputMode="numeric"
                          className="field-input mt-1" placeholder={tr("Enter counted units", "أدخل العدد الذي حسبته")}
                          value={state?.actualQty ?? ""} onChange={(e) => patch(suggestion.slotCode, { actualQty: e.target.value, reviewed: false })} />
                      </label>
                      <label className="flex items-start gap-2 text-xs text-slate-800">
                        <input type="checkbox" checked={Boolean(state?.oldAccounted)}
                          onChange={(e) => patch(suggestion.slotCode, { oldAccounted: e.target.checked, reviewed: false })}
                          className="mt-0.5" />
                        {tr("I checked this lane physically, removed any previous product, recorded its return/waste in Snacky if needed, and loaded the selected product.", "تأكدت من الخانة فعلياً وأزلت المنتج السابق، وسجلت إرجاعه أو إتلافه في سناكي عند الحاجة، ووضعت المنتج المحدد.")}
                      </label>
                      <label className="flex items-start gap-2 text-xs font-bold text-slate-900">
                        <input type="checkbox" checked={Boolean(state?.reviewed)}
                          onChange={(e) => patch(suggestion.slotCode, { reviewed: e.target.checked })} className="mt-0.5" />
                        {tr("Approve this product and count for XY", "أوافق على هذا المنتج والعدد لإرسالهما إلى XY")}
                      </label>
                      {state?.reviewed && !valid ? <p className="text-xs font-semibold text-rose-700">
                        {tr("Confirm old stock handling and enter a valid exact quantity before applying.", "أكد التعامل مع المنتج السابق وأدخل العدد الصحيح قبل التطبيق.")}
                      </p> : null}
                    </>
                  ) : null}
                </div>
              );
            })}
            {unchanged.length ? <details className="rounded-xl border border-slate-200 bg-white p-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">{tr(`Show ${unchanged.length} matching selections`, `عرض ${unchanged.length} خانة مطابقة`)}</summary>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {unchanged.map((item) => <div key={item.slotCode} className="rounded-lg bg-slate-50 p-2 text-xs"><strong>{item.slotCode}</strong> · {item.productName}</div>)}
              </div>
            </details> : null}
            {(scan.unreadableSlots?.length ?? 0) > 0 ? <p className="text-sm text-amber-900">
              {tr("Not identified — check manually", "خانات غير معروفة — راجعها يدوياً")}: {scan.unreadableSlots?.join(" · ")}
            </p> : null}
            <button type="button" onClick={() => void applyConfirmed()} disabled={!canApply || saving || scanning}
              className="btn-primary w-full disabled:opacity-50">
              {saving ? tr(`Applying ${progress}…`, `جارٍ التطبيق ${progress}…`)
                : tr(`Apply ${selected.length} reviewed changes to XY`, `تطبيق ${selected.length} تغييرات مؤكدة على XY`)}
            </button>
            {progress && !saving ? <p role="status" className="text-sm font-semibold text-emerald-800">{progress}</p> : null}
          </>
        ) : null}
        {error ? <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-medium text-rose-900">{error}</div> : null}
      </div>
    </section>
  );
}
