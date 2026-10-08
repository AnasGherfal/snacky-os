"use client";

import { useState } from "react";
import { useLanguage } from "@/components/I18nProvider";

export type QuickMachineSlot = {
  slotCode: string;
  productName: string;
  currentQty: number;
  capacity: number;
  vmsProductId: string | null;
  priceLyd?: number | null;
  productId?: string | null;
};

export type QuickMachineRow = {
  rowIndex: number;
  slots: QuickMachineSlot[];
};

function units(value: number) {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

/**
 * Machine stock is not the same as route pickup/refill stock:
 * entering 7 here means "this physical vending selection ends with 7".
 * The physical refill count stays in the separate operator-bag flow.
 */
export function MachineStockQuickEditor({
  rows,
  values,
  onChange,
  prices = {},
  onPriceChange,
  onChangeProduct,
  onHideSelection,
  hiddenSelections = [],
  onRestoreSelection,
  productOptions = [],
  productSelections = {},
  onSelectProduct,
  onSaveSelection,
  saveStatuses = {},
  onLoadAllProducts,
  productCatalogLoading = false,
}: {
  rows: QuickMachineRow[];
  values: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  prices?: Record<string, number>;
  onPriceChange?: (next: Record<string, number>) => void;
  onChangeProduct?: (slotCode: string) => void;
  onHideSelection?: (slotCode: string) => void;
  hiddenSelections?: Array<{ slot_code: string; reason?: string }>;
  onRestoreSelection?: (slotCode: string) => void;
  productOptions?: Array<{ id: string; name: string }>;
  productSelections?: Record<string, string>;
  onSelectProduct?: (slotCode: string, productId: string) => void;
  onSaveSelection?: (slotCode: string) => void;
  saveStatuses?: Record<string, { status: "saving" | "pending" | "verified" | "error"; message?: string }>;
  onLoadAllProducts?: () => void;
  productCatalogLoading?: boolean;
}) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [rowInputs, setRowInputs] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  const updateOne = (slot: QuickMachineSlot, raw: string) => {
    setError("");
    const next = { ...values };
    if (raw.trim() === "") {
      delete next[slot.slotCode];
      onChange(next);
      setFeedback(tr(`Selection ${slot.slotCode}: no stock change will be sent.`,
        `الخانة ${slot.slotCode}: لن يُرسل أي تغيير للكمية.`));
      return;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > slot.capacity) {
      setError(tr(
        `Selection ${slot.slotCode} accepts 0–${slot.capacity} units.`,
        `الخانة ${slot.slotCode} تقبل من 0 إلى ${slot.capacity} وحدات.`,
      ));
      return;
    }
    next[slot.slotCode] = parsed;
    onChange(next);
    setFeedback(tr(
      `Selection ${slot.slotCode}: final stock ${parsed} staged for Complete Stop.`,
      `الخانة ${slot.slotCode}: تم تحديد الكمية النهائية ${parsed} لحفظها عند إنهاء الموقع.`,
    ));
  };

  const setWholeRow = (row: QuickMachineRow) => {
    const raw = rowInputs[row.rowIndex]?.trim() ?? "";
    const parsed = Number(raw);
    if (!raw || !Number.isSafeInteger(parsed) || parsed < 0) {
      setError(tr("Enter a whole number of units for the row.", "أدخل عدد وحدات صحيحاً للصف."));
      return;
    }
    const applicable = row.slots.filter((slot) => slot.vmsProductId && slot.capacity > 0);
    const tooSmall = applicable.filter((slot) => parsed > slot.capacity);
    if (tooSmall.length) {
      setError(tr(
        `Row ${row.rowIndex}: ${tooSmall.map((s) => s.slotCode).join(", ")} cannot hold ${parsed}. Use a lower row value or set those selections individually.`,
        `الصف ${row.rowIndex}: الخانات ${tooSmall.map((s) => s.slotCode).join("، ")} لا تستوعب ${parsed}. اختر عدداً أقل أو عدّلها منفردة.`,
      ));
      return;
    }
    const next = { ...values };
    applicable.forEach((slot) => { next[slot.slotCode] = parsed; });
    onChange(next);
    setError("");
    setFeedback(tr(`Row ${row.rowIndex}: ${applicable.length} selections set to ${parsed}. Press Save Selection for each edited lane, or Complete Stop to save all.`,
      `تم ضبط الصف ${row.rowIndex}: ${applicable.length} خانة على ${parsed}. احفظ كل خانة أو اضغط إنهاء الموقع لحفظ الكل.`));
  };

  const updatePrice = (slot: QuickMachineSlot, raw: string) => {
    if (!onPriceChange) return;
    const next = { ...prices };
    if (!raw.trim()) {
      delete next[slot.slotCode];
      onPriceChange(next);
      setFeedback(tr(`Selection ${slot.slotCode}: price change cleared.`,
        `الخانة ${slot.slotCode}: تم إلغاء تعديل السعر.`));
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) {
      setError(tr("Price must be positive with up to two decimal places.", "السعر يجب أن يكون موجباً وبحد أقصى خانتين عشريتين."));
      return;
    }
    next[slot.slotCode] = value;
    onPriceChange(next);
    setError("");
    setFeedback(tr(`Selection ${slot.slotCode}: price ${value.toFixed(2)} LYD staged until Complete Stop.`,
      `سعر الخانة ${slot.slotCode} = ${value.toFixed(2)} د.ل محفوظ مؤقتاً إلى حين إنهاء الموقع.`));
  };

  const changedCount = new Set([...Object.keys(values), ...Object.keys(prices), ...Object.keys(productSelections)]).size;
  return (
    <section className="rounded-2xl border border-emerald-200 bg-white p-3 shadow-sm sm:p-5" aria-label={tr("Machine lane inventory", "مخزون خانات الجهاز")}>
      <div className="mb-3">
        <h2 className="text-lg font-bold text-slate-950">{tr("Machine selections", "خانات الجهاز")}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">{tr(
          "Enter the FINAL quantity physically inside each selection. Set a whole row with one number, then change any selection individually. These numbers are for XY only, not the number taken from storage.",
          "سجّل العدد النهائي الموجود فعلياً داخل كل خانة. يمكنك ضبط صف كامل برقم واحد ثم تعديل أي خانة وحدها. هذه أرقام XY ولا تمثل الكمية المسحوبة من المخزن.",
        )}</p>
        <div className="mt-2 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">
          {tr(`${changedCount} selections edited · Save Selection now or Complete Stop later`,
            `تم تعديل ${changedCount} خانة · احفظ التغييرات الآن أو عند إنهاء الموقع`)}
        </div>
      </div>

      {feedback ? <p role="status" aria-live="polite" className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-bold text-emerald-800">✓ {feedback}</p> : null}
      <div className="space-y-2">
        {rows.map((row) => {
          const usable = row.slots.filter((s) => s.vmsProductId && s.capacity > 0);
          if (!usable.length) return null;
          const rowName = `${usable[0].slotCode}–${usable[usable.length - 1].slotCode}`;
          const setCount = usable.filter((s) => Object.hasOwn(values, s.slotCode)).length;
          const open = Boolean(expanded[row.rowIndex]);
          return (
            <div key={row.rowIndex} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button type="button" onClick={() => setExpanded((prev) => ({ ...prev, [row.rowIndex]: !open }))}
                  className="min-h-11 flex-1 text-start" aria-expanded={open}>
                  <div className="font-bold text-slate-950">{tr(`Row ${row.rowIndex}`, `الصف ${row.rowIndex}`)} <span className="font-mono text-sm text-slate-500">{rowName}</span></div>
                  <div className="text-xs text-slate-500">{tr(`${setCount}/${usable.length} selected · Tap to edit lanes`, `تم ضبط ${setCount} من ${usable.length} · اضغط لتعديل الخانات`)}</div>
                </button>
                <input type="number" inputMode="numeric" min={0} step={1} placeholder={tr("Qty", "العدد")}
                  value={rowInputs[row.rowIndex] ?? ""}
                  onChange={(e) => setRowInputs((prev) => ({ ...prev, [row.rowIndex]: e.target.value }))}
                  aria-label={tr(`Row ${row.rowIndex} final quantity`, `الكمية النهائية للصف ${row.rowIndex}`)}
                  className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-3 text-center text-base font-semibold text-slate-900 sm:w-20" />
                <button type="button" onClick={() => setWholeRow(row)}
                  className="min-h-11 rounded-lg bg-emerald-700 px-3 text-sm font-bold text-white">
                  {tr("Set row", "ضبط الصف")}
                </button>
              </div>
              {open ? (
                <div className="grid grid-cols-2 gap-2 border-t border-slate-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-5">
                  {usable.map((slot) => {
                    const changed = Object.hasOwn(values, slot.slotCode) || Object.hasOwn(prices, slot.slotCode)
                      || Object.hasOwn(productSelections, slot.slotCode);
                    const actionStatus = saveStatuses[slot.slotCode];
                    return (
                      <div key={slot.slotCode} className={`rounded-lg border p-2 ${changed ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                        <span className="block font-mono text-sm font-bold text-slate-950">{slot.slotCode}</span>
                        <span title={slot.productName} className="block truncate text-xs text-slate-500">{slot.productName}</span>
                        <span className="mt-1 block text-xs font-semibold text-slate-600">
                          {tr("Current in XY", "الموجود حالياً في XY")}: <strong className="text-slate-950">{units(slot.currentQty)}</strong>
                          {" · "}{tr("Capacity", "السعة")}: {slot.capacity}
                        </span>
                        {onSelectProduct ? (
                          <label className="mt-2 block text-xs font-semibold text-slate-700">
                            {tr("Product", "المنتج")}
                            <select value={productSelections[slot.slotCode] ?? slot.productId ?? ""}
                              onChange={(event) => onSelectProduct(slot.slotCode, event.target.value)}
                              aria-label={tr(`Selection ${slot.slotCode} product`, `منتج الخانة ${slot.slotCode}`)}
                              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-950">
                              <option value="">{slot.productName || tr("Unmapped XY product", "منتج XY غير مربوط")}</option>
                              {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            {onLoadAllProducts ? <button type="button" onClick={onLoadAllProducts}
                              disabled={productCatalogLoading}
                              className="mt-1 text-xs font-semibold text-emerald-800 underline disabled:opacity-50">
                              {productCatalogLoading ? tr("Loading products…", "جارٍ تحميل المنتجات…")
                                : tr("Load all products", "عرض كل المنتجات")}
                            </button> : null}
                          </label>
                        ) : null>
                        <input type="number" inputMode="numeric" min={0} max={slot.capacity} step={1}
                          value={Object.hasOwn(values, slot.slotCode) ? values[slot.slotCode] : ""}
                          onChange={(e) => updateOne(slot, e.target.value)}
                          placeholder="—"
                          aria-label={tr(`Selection ${slot.slotCode} final quantity`, `العدد النهائي للخانة ${slot.slotCode}`)}
                          className="mt-2 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-center text-lg font-bold text-slate-950" />
                        {onPriceChange ? (
                          <label className="mt-2 block text-xs font-semibold text-slate-700">
                            {tr("Price (LYD)", "السعر (د.ل)")}
                            <input type="number" inputMode="decimal" min={0.01} max={1000} step={0.01}
                              aria-label={tr(`Selection ${slot.slotCode} price`, `سعر الخانة ${slot.slotCode}`)}
                              value={Object.hasOwn(prices, slot.slotCode) ? prices[slot.slotCode] : ""}
                              placeholder={slot.priceLyd ? Number(slot.priceLyd).toFixed(2) : "—"}
                              onChange={(e) => updatePrice(slot, e.target.value)}
                              className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-center text-base text-slate-950" />
                          </label>
                        ) : null}
                        {onSaveSelection ? (
                          <button type="button" onClick={() => onSaveSelection(slot.slotCode)}
                            disabled={actionStatus?.status === "saving" || !changed}
                            className="mt-2 min-h-11 w-full rounded-lg bg-emerald-700 px-3 text-sm font-bold text-white disabled:bg-slate-300">
                            {actionStatus?.status === "saving" ? tr("Saving…", "جارٍ الحفظ…") : tr("Save selection", "حفظ الخانة")}
                          </button>
                        ) : null}
                        {actionStatus ? (
                          <p role="status" className={`mt-1 text-xs font-semibold ${actionStatus.status === "error" ? "text-rose-700" : "text-emerald-700"}`}>
                            {actionStatus.message ?? (actionStatus.status === "pending"
                              ? tr("Saved · XY pending", "تم الحفظ · XY معلق")
                              : actionStatus.status === "verified" ? tr("XY verified", "تم التحقق في XY") : "")}
                          </p>
                        ) : null}
                        {onHideSelection ? <button type="button" onClick={() => onHideSelection(slot.slotCode)}
                          className="mt-1 min-h-9 w-full text-xs text-slate-500 underline">
                          {tr("Not physically present? Hide", "غير موجودة فعلياً؟ إخفاء")}
                        </button> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {hiddenSelections.length ? (
        <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-amber-950">
            {tr(`${hiddenSelections.length} physically absent selections hidden · Manage`,
              `${hiddenSelections.length} خانات غير موجودة فعلياً مخفية · إدارة`)}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {hiddenSelections.map((row) => <button key={row.slot_code} type="button"
              className="min-h-10 rounded-lg border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900"
              onClick={() => onRestoreSelection?.(row.slot_code)}>
              {row.slot_code} · {tr("Restore", "إظهار")}
            </button>)}
          </div>
        </details>
      ) : null}
            {error ? <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-800">{error}</p> : null}
      <p className="mt-3 text-xs text-slate-500">{tr(
        "Press Save Selection to queue that selection immediately; Complete Stop also saves any remaining stock/price edits. Background sync retries without holding the operator.",
        "اضغط حفظ الخانة لتسجيل التغيير فوراً؛ وإنهاء الموقع يحفظ باقي تعديلات السعر والكمية. تُجرى المزامنة في الخلفية دون تعطيل المشغل.",
      )}</p>
    </section>
  );
}
