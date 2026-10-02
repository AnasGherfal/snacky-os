"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { createCustomerIssue, recordCurrencyExchange } from "@/lib/business-record-actions";
import { readSavedBusinessRecord, recordMoney, validateBusinessRecord, type BusinessRecordKind } from "@/lib/business-record-validation";

type Choice = { id: string; label: string };
export function BusinessRecordForm({ kind, userId, today, machines = [] }: { kind: BusinessRecordKind; userId: string; today: string; machines?: Choice[] }) {
  const router = useRouter();
  const { locale } = useLanguage();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const key = `snacky:business-record:v1:${kind}:${userId}`;
  const [draft, setDraft] = useState<Record<string, string>>((): Record<string, string> => {
    if (kind === "exchange") return { kind, source_account_id: "snacky_lyd", destination_account_id: "snacky_usd", source_amount: "", destination_amount: "", transaction_date: today, note: "" };
    return { kind, machine_id: "", customer_name: "", customer_phone: "", contact_channel: "whatsapp", issue_type: "payment_problem", priority: "normal", description: "" };
  });
  const pendingRequest = useRef<Record<string, string> | null>(null);
  const inFlight = useRef(false);
  const [frozen, setFrozen] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [savedHref, setSavedHref] = useState("");

  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(key); } catch { setStorageWarning(true); }
    if (stored) {
      try {
        const request = readSavedBusinessRecord(stored, kind);
        pendingRequest.current = request;
        setDraft(request); setFrozen(true);
      } catch {
        setBlocked(true);
        setError("A saved request could not be read. Review the history before clearing browser data or creating another entry.");
      }
    }
    setReady(true);
  }, [key, kind]);

  const change = (name: string, value: string) => setDraft((current) => ({ ...current, [name]: value }));
  const input = (name: string, label: string, options: { type?: string; required?: boolean; maxLength?: number } = {}) => (
    <label className="block min-w-0 text-sm font-medium">{label}
      <input className="field-input mt-1 w-full" name={name} value={draft[name] ?? ""} onChange={(e) => change(name, e.target.value)} type={options.type ?? "text"} required={options.required} maxLength={options.maxLength} min={options.type === "number" ? "0.01" : options.type === "date" ? "2026-05-16" : undefined} max={options.type === "date" ? today : undefined} step={options.type === "number" ? "0.01" : undefined} inputMode={options.type === "number" ? "decimal" : options.type === "tel" ? "tel" : undefined} />
    </label>
  );
  const select = (name: string, label: string, options: Choice[]) => (
    <label className="block min-w-0 text-sm font-medium">{label}
      <select className="field-input mt-1 w-full" name={name} value={draft[name] ?? ""} onChange={(e) => change(name, e.target.value)}>{options.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>
    </label>
  );
  const spent = recordMoney(draft.source_amount), received = recordMoney(draft.destination_amount);

  async function submit() {
    if (inFlight.current || !ready || blocked || savedHref) return;
    let request = pendingRequest.current;
    if (!request) {
      // Recover another tab's pending request rather than overwrite it.
      try {
        if (window.localStorage.getItem(key)) { setBlocked(true); setError("Another saved request exists. Reload to recover it before recording a new entry."); return; }
      } catch { setStorageWarning(true); }
      request = { ...draft, client_submission_id: globalThis.crypto?.randomUUID?.() ?? "" };
      const validation = validateBusinessRecord(kind, request);
      if (validation) { setError(validation); return; }
      pendingRequest.current = request; setFrozen(true);
      try { window.localStorage.setItem(key, JSON.stringify(request)); } catch { setStorageWarning(true); }
    }
    inFlight.current = true; setBusy(true); setError("");
    const fd = new FormData();
    for (const [name, value] of Object.entries(request)) fd.set(name, value);
    try {
      const result = await (kind === "exchange" ? recordCurrencyExchange(fd) : createCustomerIssue(fd));
      if (result.ok) {
        try { window.localStorage.removeItem(key); } catch { /* Existing receipt remains safe to retry. */ }
        setSavedHref(result.href);
        router.push(result.href); router.refresh();
      } else {
        setError(result.message);
        if (!result.retrySameRequest) {
          pendingRequest.current = null; setFrozen(false);
          try { window.localStorage.removeItem(key); } catch { setStorageWarning(true); }
        }
      }
    } catch {
      setError("The result is uncertain. Retry this same saved request; do not start a new one.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <form action={submit} className="surface-card max-w-3xl space-y-4" dir={locale === "ar" ? "rtl" : "ltr"} aria-busy={busy}>
      {frozen && !savedHref ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{tr("These submitted details are saved. Retry the same request to check or complete it without duplicates.", "هذه التفاصيل محفوظة. أعد محاولة الطلب نفسه للتحقق منه أو إكماله دون تكرار.")}</p> : null}
      {error ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-900">{error}</p> : null}
      {storageWarning ? <p className="text-sm text-amber-900">{tr("Browser storage is unavailable. Keep this page open until the result is confirmed.", "تخزين المتصفح غير متاح. أبقِ الصفحة مفتوحة حتى تتأكد النتيجة.")}</p> : null}
      {savedHref ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{tr("Saved successfully.", "تم الحفظ بنجاح.")} <Link className="underline" href={savedHref}>{tr("View saved record", "عرض السجل")}</Link></p> : null}
      <fieldset disabled={!ready || busy || frozen || blocked || Boolean(savedHref)} className="grid min-w-0 gap-4 border-0 p-0 md:grid-cols-2">
        {kind === "exchange" ? <>
          {select("source_account_id", tr("From LYD account", "من حساب الدينار"), [{ id: "snacky_lyd", label: tr("Snacky LYD", "سناكي — دينار") }, { id: "owner_lyd", label: tr("Owner LYD", "المالك — دينار") }])}
          {select("destination_account_id", tr("To USD account", "إلى حساب الدولار"), [{ id: "snacky_usd", label: tr("Snacky USD", "سناكي — دولار") }, { id: "owner_usd", label: tr("Owner USD", "المالك — دولار") }])}
          {input("source_amount", tr("LYD paid for the dollars", "الدينار المدفوع لشراء الدولار"), { type: "number", required: true })}
          {input("destination_amount", tr("USD actually received", "الدولار المستلم فعلياً"), { type: "number", required: true })}
          {input("transaction_date", tr("Exchange date", "تاريخ الصرف"), { type: "date", required: true })}
          {input("note", tr("Exchange office / reference / note", "مكتب الصرافة / المرجع / الملاحظة"), { maxLength: 2000 })}
        </> : <>
          {input("customer_name", tr("Customer name (optional)", "اسم العميل (اختياري)"), { maxLength: 150 })}
          {input("customer_phone", tr("Phone / WhatsApp (optional)", "الهاتف / واتساب (اختياري)"), { type: "tel", maxLength: 50 })}
          {select("machine_id", tr("Machine / location", "الماكينة / الموقع"), [{ id: "", label: tr("Unknown / general issue", "غير محددة / بلاغ عام") }, ...machines])}
          {select("contact_channel", tr("Contact channel", "قناة التواصل"), [{ id: "whatsapp", label: "WhatsApp" }, { id: "phone", label: tr("Phone call", "مكالمة") }, { id: "facebook", label: "Facebook" }, { id: "instagram", label: "Instagram" }, { id: "in_person", label: tr("In person", "حضوري") }, { id: "other", label: tr("Other", "أخرى") }])}
          {select("issue_type", tr("Issue type", "نوع البلاغ"), [{ id: "payment_problem", label: tr("Payment / change problem", "مشكلة دفع / باقي") }, { id: "product_stuck", label: tr("Product not delivered", "المنتج لم ينزل") }, { id: "machine_down", label: tr("Machine not working", "الماكينة لا تعمل") }, { id: "product_quality", label: tr("Product quality", "جودة المنتج") }, { id: "other", label: tr("Other", "أخرى") }])}
          {select("priority", tr("Priority", "الأولوية"), [{ id: "low", label: tr("Low", "منخفضة") }, { id: "normal", label: tr("Normal", "عادية") }, { id: "high", label: tr("High", "مرتفعة") }, { id: "critical", label: tr("Critical", "عاجلة جداً") }])}
          <label className="block text-sm font-medium md:col-span-2">{tr("What happened?", "ماذا حدث؟")}<textarea className="field-input mt-1 w-full" name="description" value={draft.description ?? ""} onChange={(e) => change("description", e.target.value)} required rows={4} maxLength={5000} /></label>
        </>}
      </fieldset>
      {kind === "exchange" ? <div className="rounded-lg bg-slate-50 p-4 text-sm">
        <p className="font-semibold" dir="ltr">{spent && received ? `${spent.toFixed(2)} LYD → ${received.toFixed(2)} USD · 1 USD = ${(spent / received).toFixed(6)} LYD` : tr("Enter both amounts to see your actual exchange rate.", "أدخل المبلغين لعرض سعر الصرف الفعلي.")}</p>
        <p className="mt-2">{tr("This records an exchange already made. It decreases the LYD account and increases the USD account; it does not send money or record sales/operating expenses. Record a separately charged commission as a separate Money Out entry.", "يسجّل عملية صرف تمت فعلياً: ينقص رصيد الدينار ويزيد رصيد الدولار، دون إرسال أموال أو تسجيل مبيعات أو مصروف تشغيلي. سجّل العمولة المنفصلة كمصروف مستقل.")}</p>
      </div> : <p className="text-sm text-slate-600">{tr("No route or photo is required. The issue is saved as Open. Business requests for a machine belong in Leads & Visits.", "لا تحتاج إلى جولة أو صورة. يُحفظ البلاغ بحالة مفتوح. طلبات الجهات للحصول على ماكينة تُسجَّل في الجهات والزيارات.")}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary" disabled={!ready || busy || blocked || Boolean(savedHref)}>{busy ? tr("Saving…", "جارٍ الحفظ…") : frozen ? tr("Retry saved request", "إعادة محاولة الطلب المحفوظ") : kind === "exchange" ? tr("Confirm exchange", "تأكيد تسجيل الصرف") : tr("Save issue", "حفظ البلاغ")}</button>
        <Link href={kind === "exchange" ? "/finance/transactions" : "/issues"} className="btn-secondary">{tr("Back to history", "العودة للسجل")}</Link>
      </div>
    </form>
  );
}
