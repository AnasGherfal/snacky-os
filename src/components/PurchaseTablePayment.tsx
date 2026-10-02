"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { recordInlineSupplierPayment } from "@/lib/supplier-payment-actions";
import { isPurchaseOperationId } from "@/lib/purchase-operation-id";
import { supplierPaymentToday, type SupplierPaymentState } from "@/lib/supplier-payment-state";

type PaymentDraft = Record<string, string>;
// Mobile and desktop render separate rows. Retain a shared in-memory fallback
// when browser storage is unavailable; reopening must not mint a second request.
const pendingRequests = new Map<string, PaymentDraft>();

type Props = {
  purchaseId: string;
  userId: string;
  supplier: string;
  receipt: string;
  paymentState: SupplierPaymentState;
  defaultAccount?: string | null;
  defaultMethod?: string | null;
};

export function PurchaseTablePayment({ purchaseId, userId, supplier, receipt, paymentState, defaultAccount, defaultMethod }: Props) {
  const router = useRouter();
  const { locale } = useLanguage();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const headingId = useId();
  const storageKey = `snacky:supplier-payment:table:v1:${userId}:${purchaseId}`;
  const [draft, setDraft] = useState<PaymentDraft>({});
  const [savedRequest, setSavedRequest] = useState<PaymentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const money = (value: number | null) => value === null ? "—" : `${value.toFixed(2)} ${tr("LYD", "د.ل")}`;

  const open = () => {
    setError("");
    setRecoveryBlocked(false);
    setStorageWarning(false);
    const inMemory = pendingRequests.get(storageKey) ?? savedRequest;
    if (inMemory) {
      setDraft(inMemory);
      setSavedRequest(inMemory);
      dialog.current?.showModal();
      return;
    }
    setSavedRequest(null);
    const next: PaymentDraft = {
      purchase_order_id: purchaseId,
      amount: (paymentState.remaining ?? 0).toFixed(2),
      expected_remaining: (paymentState.remaining ?? 0).toFixed(2),
      paid_at: supplierPaymentToday(),
      payment_method: ["cash", "bank_transfer", "card", "other"].includes(defaultMethod ?? "") ? defaultMethod! : "cash",
      account_id: defaultAccount === "owner_lyd" ? "owner_lyd" : "snacky_lyd",
      reference: "", note: "", confirm_payment: "yes",
    };
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(storageKey); } catch { setStorageWarning(true); }
    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored);
        const keys = [...Object.keys(next), "client_submission_id"];
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || keys.some((key) => typeof (parsed as PaymentDraft)[key] !== "string")
          || Object.keys(parsed).some((key) => !keys.includes(key))
          || (parsed as PaymentDraft).purchase_order_id !== purchaseId
          || !isPurchaseOperationId((parsed as PaymentDraft).client_submission_id)) {
          throw new Error("Invalid saved payment request");
        }
        const request = parsed as PaymentDraft;
        pendingRequests.set(storageKey, request);
        setDraft(request);
        setSavedRequest(request);
        dialog.current?.showModal();
        return;
      } catch {
        // Corrupt data might describe a committed payment with a lost response.
        // Never erase it and quietly allow a new request/UUID.
        setRecoveryBlocked(true);
        setError(tr("A saved payment request could not be read. Check this purchase's payment history before recording another payment.", "تعذر قراءة طلب الدفع المحفوظ. راجع سجل دفعات هذه الفاتورة قبل تسجيل دفعة أخرى."));
      }
    }
    setDraft(next);
    dialog.current?.showModal();
  };

  const submit = async () => {
    if (inFlight.current || recoveryBlocked) return;
    const request = pendingRequests.get(storageKey) ?? savedRequest ?? { ...draft, client_submission_id: globalThis.crypto?.randomUUID?.() ?? "" };
    if (!isPurchaseOperationId(request.client_submission_id)) {
      setError(tr("Could not create a safe payment request. Refresh before retrying.", "تعذر إنشاء طلب دفع آمن. حدّث الصفحة وأعد المحاولة."));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setSavedRequest(request);
    pendingRequests.set(storageKey, request);
    try { window.localStorage.setItem(storageKey, JSON.stringify(request)); } catch { setStorageWarning(true); }
    const fd = new FormData();
    for (const [key, value] of Object.entries(request)) fd.set(key, value);
    try {
      const result = await recordInlineSupplierPayment(fd);
      if (result.ok) {
        pendingRequests.delete(storageKey);
        try { window.localStorage.removeItem(storageKey); } catch { /* Keep in-memory success. */ }
        setSavedRequest(null);
        setSuccess(true);
        dialog.current?.close();
        router.refresh(); // Preserve this list's URL, filters and pagination.
      } else {
        setError(result.message);
        if (!result.retrySameRequest) {
          pendingRequests.delete(storageKey);
          try { window.localStorage.removeItem(storageKey); } catch { /* No write occurred. */ }
          setSavedRequest(null);
          setRecoveryBlocked(true); // Reopen after refresh to review the new balance.
        }
        router.refresh();
      }
    } catch {
      // Keep both payload and UUID. A lost response is not proof of failed payment.
      setError(tr("The result could not be confirmed. Retry the saved payment below; do not record a new one.", "تعذر تأكيد النتيجة. أعد محاولة الطلب المحفوظ أدناه ولا تسجل دفعة جديدة."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const change = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="min-w-0">
      {success ? <p role="status" className="mb-2 text-xs font-medium text-emerald-700">{tr("Payment recorded · Finance updated", "تم تسجيل الدفع وتحديث المالية")}</p> : null}
      <button type="button" className="btn-primary" onClick={open} disabled={busy || (!paymentState.ready && !savedRequest)} title={paymentState.reason || undefined}>
        {tr("Mark paid", "تسجيل الدفع")}
      </button>
      {!paymentState.ready && paymentState.remaining !== 0 ? <p className="mt-1 max-w-64 whitespace-normal text-xs text-amber-800">{paymentState.reason}</p> : null}
      <dialog ref={dialog} aria-labelledby={headingId} dir={locale === "ar" ? "rtl" : "ltr"}
        onCancel={(event) => { if (inFlight.current) event.preventDefault(); }}
        className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto whitespace-normal rounded-2xl border border-slate-200 bg-white p-5 text-start text-slate-900 shadow-xl backdrop:bg-slate-950/50">
        <h2 id={headingId} className="text-lg font-semibold">{tr("Record supplier payment", "تسجيل دفعة للمورد")}</h2>
        <p className="mt-1 break-words text-sm text-slate-600">{supplier} · {tr("Receipt", "الفاتورة")} {receipt}</p>
        <div className="my-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
          <div>{tr("Invoice", "الإجمالي")}<strong className="mt-1 block break-words" dir="ltr">{money(paymentState.total)}</strong></div>
          <div>{tr("Already paid", "المدفوع")}<strong className="mt-1 block break-words" dir="ltr">{money(paymentState.paid)}</strong></div>
          <div>{tr("Remaining", "المتبقي")}<strong className="mt-1 block break-words" dir="ltr">{money(paymentState.remaining)}</strong></div>
        </div>
        <p className="mb-4 text-sm text-slate-600">{tr("Record money already paid to this supplier. This updates Finance; it does not send money or receive stock again.", "سجّل المبلغ المدفوع فعلياً للمورد. يتم تحديث المالية دون إرسال أموال أو استلام المخزون مرة أخرى.")}</p>
        {savedRequest ? <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{tr("A payment request is saved. Retry these same details to safely check or complete it without a duplicate.", "يوجد طلب دفع محفوظ. أعد المحاولة بنفس التفاصيل للتحقق منه أو إكماله دون تكرار الدفع.")}</p> : null}
        {storageWarning ? <p className="mb-3 text-xs text-amber-900">{tr("Browser storage is unavailable. Keep this window open until the payment result is confirmed.", "تخزين المتصفح غير متاح. أبقِ هذه النافذة مفتوحة حتى تتأكد نتيجة الدفع.")}</p> : null}
        {error ? <div role="alert" className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div> : null}
        {recoveryBlocked ? <p className="mb-3 text-sm text-slate-600">{tr("Close and reopen this dialog after reviewing the refreshed balance. For a saved-request warning, review the payment history first.", "أغلق النافذة وأعد فتحها بعد مراجعة الرصيد المحدّث. عند وجود تحذير عن طلب محفوظ، راجع سجل الدفعات أولاً.")}</p> : null}
        <form action={submit}>
          <fieldset disabled={busy || Boolean(savedRequest) || recoveryBlocked} className="grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2">
            <label className="text-sm font-medium">{tr("Amount (LYD)", "المبلغ (د.ل)")}
              <input className="field-input mt-1" name="amount" type="number" inputMode="decimal" min="0.01" max={paymentState.remaining ?? undefined} step="0.01" value={draft.amount ?? ""} onChange={(e) => change("amount", e.target.value)} required />
            </label>
            <label className="text-sm font-medium">{tr("Payment date", "تاريخ الدفع")}
              <input className="field-input mt-1" name="paid_at" type="date" value={draft.paid_at ?? ""} onChange={(e) => change("paid_at", e.target.value)} required />
            </label>
            <label className="text-sm font-medium">{tr("Paying account", "الحساب المدفوع منه")}
              <select className="field-input mt-1" name="account_id" value={draft.account_id ?? "snacky_lyd"} onChange={(e) => change("account_id", e.target.value)} required>
                <option value="snacky_lyd">{tr("Snacky LYD", "سناكي — دينار")}</option><option value="owner_lyd">{tr("Owner LYD", "المالك — دينار")}</option>
              </select>
            </label>
            <label className="text-sm font-medium">{tr("Payment method", "طريقة الدفع")}
              <select className="field-input mt-1" name="payment_method" value={draft.payment_method ?? "cash"} onChange={(e) => change("payment_method", e.target.value)} required>
                <option value="cash">{tr("Cash", "نقداً")}</option><option value="bank_transfer">{tr("Bank transfer", "تحويل مصرفي")}</option><option value="card">{tr("Card", "بطاقة")}</option><option value="other">{tr("Other", "أخرى")}</option>
              </select>
            </label>
            <label className="text-sm font-medium sm:col-span-2">{tr("Reference (optional)", "المرجع (اختياري)")}
              <input className="field-input mt-1" name="reference" maxLength={200} value={draft.reference ?? ""} onChange={(e) => change("reference", e.target.value)} />
            </label>
            <label className="text-sm font-medium sm:col-span-2">{tr("Note (optional)", "ملاحظة (اختياري)")}
              <textarea className="field-input mt-1" name="note" rows={2} maxLength={2000} value={draft.note ?? ""} onChange={(e) => change("note", e.target.value)} />
            </label>
          </fieldset>
          <p className="my-3 text-xs text-slate-500">{tr("The full remaining balance is prefilled. A smaller amount records a partial payment.", "تم إدخال كامل المبلغ المتبقي. إدخال مبلغ أقل يسجّل دفعة جزئية.")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => dialog.current?.close()}>{tr("Close", "إغلاق")}</button>
            <button type="submit" className="btn-primary" disabled={busy || recoveryBlocked || (!savedRequest && !paymentState.ready)}>
              {busy ? tr("Recording…", "جارٍ التسجيل…") : savedRequest ? tr("Retry saved payment", "إعادة محاولة الطلب المحفوظ") : tr("Confirm payment", "تأكيد الدفع")}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
