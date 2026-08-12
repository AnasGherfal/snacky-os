"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { uploadRefillProofPhoto } from "@/lib/operator-actions";

function openSection(eventName: string, targetId: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
  window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function routeScope() {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/\/operator\/routes\/([^/]+)\/stops\/([^/]+)/);
  return match ? { routeId: match[1], stopId: match[2] } : null;
}

function clientId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  category?: string | null;
  brand?: string | null;
  current_selling_price_lyd?: number | null;
  selling_price?: number | null;
};

type CompensationRecord = {
  id: string;
  product_name: string;
  quantity: number;
  claim_type: string;
  claimed_amount_lyd?: number | null;
  notes?: string | null;
  compensated_at: string;
  needs_review?: boolean;
  review_reason?: string | null;
};

export function RouteStopQuickActions() {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [compOpen, setCompOpen] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [photoSaved, setPhotoSaved] = useState(false);
  const [photoSavedAt, setPhotoSavedAt] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [records, setRecords] = useState<CompensationRecord[]>([]);
  const [installed, setInstalled] = useState(true);
  const [productQuery, setProductQuery] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [claimType, setClaimType] = useState("paid_no_product");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [compSaving, setCompSaving] = useState(false);
  const [compError, setCompError] = useState("");
  const [compWarning, setCompWarning] = useState("");
  const submissionId = useRef(clientId());
  const scope = routeScope();

  useEffect(() => {
    if (!scope) return;
    fetch(`/api/operator/routes/${scope.routeId}/stops/${scope.stopId}/completion-photo`, { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!payload) return;
        setMachineId(String(payload.machineId ?? ""));
        setPhotoSaved(Boolean(payload.saved));
        setPhotoSavedAt(payload.savedAt ?? null);
      })
      .catch(() => undefined);
  }, [scope?.routeId, scope?.stopId]);

  async function loadCompensations() {
    if (!scope) return;
    setCompError("");
    const response = await fetch(`/api/operator/routes/${scope.routeId}/stops/${scope.stopId}/compensations`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || tr("Could not load customer compensation.", "تعذر تحميل تعويضات العملاء."));
    setInstalled(payload?.installed !== false);
    setProducts(Array.isArray(payload?.products) ? payload.products : []);
    setRecords(Array.isArray(payload?.records) ? payload.records : []);
  }

  useEffect(() => {
    if (!compOpen) return;
    void loadCompensations().catch((error) => setCompError(error instanceof Error ? error.message : tr("Could not load customer compensation.", "تعذر تحميل تعويضات العملاء.")));
  }, [compOpen]);

  const filteredProducts = useMemo(() => {
    const needle = productQuery.trim().toLowerCase();
    const rows = needle
      ? products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      : products;
    return rows.slice(0, needle ? 50 : 20);
  }, [products, productQuery]);
  const selectedProduct = products.find((product) => product.id === productId) ?? null;

  async function saveMachinePhoto() {
    if (!scope || !machineId) {
      setPhotoError(tr("Machine information is still loading. Try again.", "بيانات الماكينة ما زالت قيد التحميل. حاول مرة أخرى."));
      return;
    }
    if (!photoFile) {
      setPhotoError(tr("Take or choose the final machine photo.", "التقط أو اختر صورة الماكينة النهائية."));
      return;
    }
    setPhotoSaving(true);
    setPhotoError("");
    try {
      const form = new FormData();
      form.append("routeId", scope.routeId);
      form.append("stopId", scope.stopId);
      form.append("machineId", machineId);
      form.append("photo", photoFile);
      const uploaded = await uploadRefillProofPhoto(form);
      if (uploaded.uploadUnavailable || (!uploaded.photoUrl && !uploaded.photoPath)) throw new Error(tr("The photo could not be uploaded.", "تعذر رفع الصورة."));
      const response = await fetch(`/api/operator/routes/${scope.routeId}/stops/${scope.stopId}/completion-photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ photoUrl: uploaded.photoUrl ?? null, photoPath: uploaded.photoPath ?? null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || tr("Could not save machine photo.", "تعذر حفظ صورة الماكينة."));
      setPhotoSaved(true);
      setPhotoSavedAt(payload?.savedAt ?? new Date().toISOString());
      setPhotoFile(null);
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : tr("Could not save machine photo.", "تعذر حفظ صورة الماكينة."));
    } finally {
      setPhotoSaving(false);
    }
  }

  async function saveCompensation() {
    if (!scope) return;
    if (!productId) {
      setCompError(tr("Choose the product given to the customer.", "اختر المنتج الذي تم إعطاؤه للعميل."));
      return;
    }
    if (quantity <= 0) {
      setCompError(tr("Quantity must be greater than zero.", "يجب أن تكون الكمية أكبر من صفر."));
      return;
    }
    setCompSaving(true);
    setCompError("");
    setCompWarning("");
    try {
      const response = await fetch(`/api/operator/routes/${scope.routeId}/stops/${scope.stopId}/compensations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          productId,
          quantity,
          claimType,
          claimedAmountLyd: claimedAmount || null,
          notes,
          clientSubmissionId: submissionId.current,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || tr("Could not save compensation.", "تعذر حفظ التعويض."));
      if (payload?.warning) setCompWarning(String(payload.warning));
      setProductId("");
      setProductQuery("");
      setQuantity(1);
      setClaimType("paid_no_product");
      setClaimedAmount("");
      setNotes("");
      submissionId.current = clientId();
      await loadCompensations();
    } catch (error) {
      setCompError(error instanceof Error ? error.message : tr("Could not save compensation.", "تعذر حفظ التعويض."));
    } finally {
      setCompSaving(false);
    }
  }

  return (
    <>
      <section className="sticky top-2 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Quick stop actions", "إجراءات الموقع السريعة")}</div>
          {photoSaved ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">{tr("Machine photo saved", "صورة الماكينة محفوظة")}</span> : null}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-manual-sale", "manual-route-sales")}>{tr("Manual sale", "بيع يدوي")}</button>
          <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => setCompOpen(true)}>{tr("Compensation", "تعويض عميل")}</button>
          <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-inventory-adjustment", "inventory-adjustments", { adjustmentType: "damaged" })}>{tr("Damaged", "تالف")}</button>
          <button type="button" className="btn-secondary min-h-12 px-2 text-sm" onClick={() => openSection("snacky:open-inventory-adjustment", "inventory-adjustments", { adjustmentType: "returned_from_machine" })}>{tr("Return", "إرجاع من الجهاز")}</button>
          <button type="button" className={photoSaved ? "min-h-12 rounded-lg border border-emerald-300 bg-emerald-50 px-2 text-sm font-semibold text-emerald-800" : "btn-secondary min-h-12 px-2 text-sm"} onClick={() => setPhotoOpen(true)}>{photoSaved ? tr("Photo saved", "الصورة محفوظة") : tr("Machine photo", "صورة الماكينة")}</button>
        </div>
        <p className="mt-2 text-xs text-slate-500">{tr("Customer compensation is tracked separately and never counts as a sale or revenue.", "تعويض العميل يُسجَّل بشكل مستقل ولا يُحسب كبيع أو إيراد.")}</p>
      </section>

      {photoOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-3 sm:items-center" onClick={() => !photoSaving && setPhotoOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()} dir={locale === "ar" ? "rtl" : "ltr"}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Required machine proof", "صورة الماكينة المطلوبة")}</div>
                <h2 className="mt-1 text-xl font-bold text-slate-950">{tr("Save final machine photo", "حفظ صورة الماكينة النهائية")}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{tr("Save it now. Once saved, it stays attached to this stop even if the app closes or crashes.", "احفظها الآن. بعد الحفظ تبقى مرتبطة بهذا الموقع حتى لو أُغلق التطبيق أو تعطل.")}</p>
              </div>
              <button type="button" className="text-2xl text-slate-400" onClick={() => setPhotoOpen(false)}>×</button>
            </div>
            {photoSaved ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{tr("Photo already saved", "الصورة محفوظة بالفعل")}{photoSavedAt ? ` · ${new Date(photoSavedAt).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}` : ""}</div> : null}
            <label className="mt-4 block">
              <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Take / choose photo", "التقاط / اختيار صورة")}</span>
              <input type="file" accept="image/*" capture="environment" className="field-input" onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)} />
            </label>
            {photoError ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{photoError}</div> : null}
            <button type="button" onClick={() => void saveMachinePhoto()} disabled={photoSaving} className="btn-primary mt-4 w-full disabled:opacity-50">{photoSaving ? `${tr("Saving", "جارٍ الحفظ")}...` : tr("Save machine photo", "حفظ صورة الماكينة")}</button>
          </div>
        </div>
      ) : null}

      {compOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-3 sm:items-center" onClick={() => !compSaving && setCompOpen(false)}>
          <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()} dir={locale === "ar" ? "rtl" : "ltr"}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Customer service", "خدمة العميل")}</div>
                <h2 className="mt-1 text-xl font-bold text-slate-950">{tr("Customer compensation", "تعويض عميل")}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{tr("Use this when a customer says they paid but did not receive the product, or when you give a replacement. This is not a sale.", "استخدم هذا عندما يقول العميل إنه دفع ولم يستلم المنتج، أو عندما تعطيه منتجاً بديلاً. هذا ليس بيعاً.")}</p>
              </div>
              <button type="button" className="text-2xl text-slate-400" onClick={() => setCompOpen(false)}>×</button>
            </div>
            {!installed ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">{tr("Customer compensation database setup is not installed yet.", "تحديث قاعدة بيانات تعويض العملاء غير مثبت بعد.")}</div> : null}

            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Search product given", "ابحث عن المنتج الذي تم إعطاؤه")}</span>
                <input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} className="field-input" placeholder={tr("Name, brand, SKU or barcode", "الاسم أو العلامة أو الرمز أو الباركود")} />
              </label>
              <div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                {selectedProduct && !productQuery ? <div className="mb-2 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">{tr("Selected", "المحدد")}: {selectedProduct.name}</div> : null}
                {filteredProducts.map((product) => (
                  <button key={product.id} type="button" onClick={() => { setProductId(product.id); setProductQuery(""); }} className={`mb-1 block w-full rounded-md px-3 py-2 text-start text-sm ${product.id === productId ? "brand-selected" : "bg-white hover:bg-slate-100"}`}>
                    <span className="font-medium">{product.name}</span>{product.brand ? <span className="text-slate-500"> · {product.brand}</span> : null}
                  </button>
                ))}
                {!filteredProducts.length ? <div className="p-3 text-sm text-slate-500">{tr("No products found", "لا توجد منتجات")}</div> : null}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Quantity given", "الكمية المعطاة")}</span>
                  <input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))} className="field-input" />
                </label>
                <label>
                  <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Customer says they paid", "المبلغ الذي قال العميل إنه دفعه")}</span>
                  <input type="number" min="0" step="0.5" value={claimedAmount} onChange={(event) => setClaimedAmount(event.target.value)} className="field-input" placeholder={tr("Optional", "اختياري")} />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Reason", "السبب")}</span>
                <select value={claimType} onChange={(event) => setClaimType(event.target.value)} className="field-input">
                  <option value="paid_no_product">{tr("Paid but nothing came out", "دفع ولم يخرج المنتج")}</option>
                  <option value="wrong_product">{tr("Wrong product dispensed", "خرج منتج خاطئ")}</option>
                  <option value="damaged_or_stuck">{tr("Product damaged or stuck", "المنتج تالف أو عالق")}</option>
                  <option value="other">{tr("Other", "سبب آخر")}</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Note", "ملاحظة")}</span>
                <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} className="field-input" placeholder={tr("Optional details about the customer's claim", "تفاصيل اختيارية عن شكوى العميل")} />
              </label>
              {compError ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{compError}</div> : null}
              {compWarning ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">{compWarning}</div> : null}
              <button type="button" onClick={() => void saveCompensation()} disabled={compSaving || !installed} className="btn-primary w-full disabled:opacity-50">{compSaving ? `${tr("Saving", "جارٍ الحفظ")}...` : tr("Record compensation", "تسجيل التعويض")}</button>
            </div>

            {records.length ? (
              <div className="mt-6 border-t border-slate-200 pt-4">
                <h3 className="font-semibold text-slate-900">{tr("Compensation at this machine stop", "التعويضات في هذا الموقع")}</h3>
                <div className="mt-3 space-y-2">
                  {records.map((record) => (
                    <div key={record.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div><span className="font-semibold text-slate-900">{record.product_name}</span> × {record.quantity}</div>
                        <div className="text-xs text-slate-500">{new Date(record.compensated_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}</div>
                      </div>
                      {record.claimed_amount_lyd != null ? <div className="mt-1 text-slate-600">{tr("Claimed payment", "المبلغ المدفوع حسب العميل")}: {Number(record.claimed_amount_lyd).toLocaleString()} LYD</div> : null}
                      {record.needs_review ? <div className="mt-2 text-xs font-semibold text-amber-700">{tr("Inventory review needed", "يحتاج مراجعة للمخزون")}{record.review_reason ? ` · ${record.review_reason}` : ""}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
