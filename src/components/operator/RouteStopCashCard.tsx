"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { prepareCashPhoto } from "@/lib/cash-photo";

type CashStatus = "pending" | "collected" | "exception" | null;
type Payload = {
  ok: boolean; required?: boolean; completed?: boolean; status?: CashStatus;
  bagId?: string | null; collectionId?: string | null;
  requestId?: string | null; error?: string;
};

export function RouteStopCashCard({
  routeId, stopId, machineId, onReadyChange,
}: {
  routeId: string; stopId: string; machineId: string;
  onReadyChange: (required: boolean, ready: boolean, state: CashStatus) => void;
}) {
  const endpoint = `/api/operator/routes/${routeId}/stops/${stopId}/cash`;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [required, setRequired] = useState(false);
  const [status, setStatus] = useState<CashStatus>(null);
  const [bagId, setBagId] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [decision, setDecision] = useState<"collected" | "exception">("collected");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [coinBox, setCoinBox] = useState(false);
  const [recycler, setRecycler] = useState(false);
  const [partial, setPartial] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState("");
  const requestRef = useRef<string | null>(null);
  const onReadyRef = useRef(onReadyChange);
  useEffect(() => { onReadyRef.current = onReadyChange; }, [onReadyChange]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as Payload;
        if (!response.ok || !data.ok) throw new Error(data.error || "تعذر تحميل حالة النقدية");
        if (canceled) return;
        setRequired(Boolean(data.required));
        setStatus(data.status ?? null);
        setBagId(data.bagId ?? "");
        setCollectionId(data.collectionId ?? null);
        if (data.requestId) requestRef.current = data.requestId;
        onReadyRef.current(Boolean(data.required), ["collected","exception"].includes(String(data.status)), data.status ?? null);
      })
      .catch(() => { if (!canceled) setError("تعذر تحميل النقدية. يرجى تحديث الصفحة."); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [endpoint]);

  if (loading) return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm" dir="rtl">جارٍ التحقق من خطوة النقدية...</p>;
  if (!required) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (!requestRef.current) requestRef.current = crypto.randomUUID();
      const form = new FormData();
      form.set("request_id", requestRef.current);
      form.set("decision", decision);
      if (decision === "collected") {
        if (!bagId.trim() || !photo) throw Error("أدخل رقم الكيس وصوّر الختم.");
        form.set("bag_id", bagId.trim().toUpperCase());
        form.set("photo", await prepareCashPhoto(photo));
        form.set("removal_type", partial ? "partial" : "full");
        form.append("compartments", "notes");
        if (coinBox) form.append("compartments", "coins");
        if (recycler) form.append("compartments", "recycler");
        form.set("notes", notes);
      } else {
        form.set("reason", reason);
        form.set("notes", notes);
      }
      const response = await fetch(endpoint, { method: "POST", body: form, cache: "no-store" });
      const result = await response.json() as Payload & { state?: CashStatus; retryable?: boolean };
      if (!response.ok || !result.ok) throw Error(result.error ?? "تعذر حفظ النقدية. حاول مرة أخرى.");
      const next = result.state ?? null;
      setStatus(next);
      setCollectionId(result.collectionId ?? null);
      onReadyRef.current(true, ["collected","exception"].includes(String(next)), next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر حفظ النقدية.");
    } finally { setSaving(false); }
  }

  return (
    <section id="cash-collection" data-machine-id={machineId} dir="rtl" className="scroll-mt-24 rounded-2xl border border-emerald-200 bg-white p-4 md:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-950">النقدية عند التعبئة</h2>
        <span className={status === "collected" || status === "exception"
          ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900"
          : "rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900"}>
          {status === "collected" ? "تم تسجيل السحب" : status === "exception" ? "تم تسجيل التعذر" : "مطلوب قبل إنهاء التعبئة"}
        </span>
      </div>
      {status === "collected" || status === "exception" ? (
        <div className="space-y-2 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-950">
          <strong>{status === "collected" ? "تم حفظ سحب النقدية بنجاح" : "تم تسجيل سبب تعذر السحب"}</strong>
          {status === "collected" ? <p>الكيس: <bdi className="font-mono font-bold">{bagId}</bdi></p> : null}
          <p>يمكنك الآن إكمال تعبئة الماكينة. سيتم استلام وعدّ النقدية في خطوة منفصلة.</p>
          {collectionId ? <Link href={`/cash-handling?id=${collectionId}`} className="inline-block font-semibold underline">عرض الكيس وتسجيل الإيداع</Link> : null}
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm leading-6 text-slate-600">
            سجّل كيس النقدية المختوم عند كل تعبئة. لا تكتب قيمة المبلغ ولا تصوّر الفلوس.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={`flex min-h-12 items-center gap-2 rounded-xl border px-3 text-sm font-semibold ${decision === "collected" ? "border-emerald-500 bg-emerald-50" : "border-slate-200"}`}>
              <input type="radio" name="decision" checked={decision === "collected"} onChange={() => setDecision("collected")}/>
              سحبت النقدية
            </label>
            <label className={`flex min-h-12 items-center gap-2 rounded-xl border px-3 text-sm font-semibold ${decision === "exception" ? "border-amber-500 bg-amber-50" : "border-slate-200"}`}>
              <input type="radio" name="decision" checked={decision === "exception"} onChange={() => setDecision("exception")}/>
              تعذر سحب النقدية
            </label>
          </div>
          {decision === "collected" ? <>
            <label className="block space-y-2 text-sm font-semibold">
              <span>رقم الكيس الأمني المعتم</span>
              <input className="field-input" dir="ltr" required autoComplete="off" maxLength={80}
                placeholder="SNK-000125" value={bagId} onChange={e => setBagId(e.target.value.toUpperCase())}/>
            </label>
            <label className="block space-y-2 text-sm font-semibold">
              <span>صورة رقم الكيس والختم بعد إغلاقه</span>
              <input className="field-input" type="file" accept="image/jpeg,image/png,image/webp"
                capture="environment" required onChange={e => setPhoto(e.target.files?.[0] ?? null)}/>
            </label>
            <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
              <p className="font-semibold">شنو فرّغت من الماكينة؟</p>
              <p className="text-xs text-slate-500">صندوق الأوراق النقدية محدد دائماً. حدد الباقي فقط عند تفريغه.</p>
              <label className="flex gap-2"><input type="checkbox" checked readOnly disabled/> صندوق الأوراق النقدية</label>
              <label className="flex gap-2"><input type="checkbox" checked={coinBox} onChange={e=>setCoinBox(e.target.checked)}/> صندوق العملات المعدنية</label>
              <label className="flex gap-2"><input type="checkbox" checked={recycler} onChange={e=>setRecycler(e.target.checked)}/> إعادة تدوير الأوراق النقدية</label>
              <label className="flex gap-2"><input type="checkbox" checked={partial} onChange={e=>setPartial(e.target.checked)}/> تركت جزء من النقدية داخل الماكينة</label>
            </div>
          </> : (
            <label className="block space-y-2 text-sm font-semibold">
              <span>سبب تعذر السحب</span>
              <select className="field-input" required value={reason} onChange={e=>setReason(e.target.value)}>
                <option value="">اختار السبب</option>
                <option value="unsafe">ظروف غير آمنة</option>
                <option value="machine_offline">عطل أو انقطاع الكهرباء</option>
                <option value="cash_access_blocked">صندوق النقدية لا يمكن فتحه</option>
                <option value="other">سبب آخر</option>
              </select>
            </label>
          )}
          {decision === "exception" || partial ? (
            <label className="block space-y-2 text-sm font-semibold">
              <span>التوضيح</span>
              <textarea className="field-input" required minLength={5} rows={2} value={notes}
                onChange={e=>setNotes(e.target.value)} placeholder="اكتب شنو صار باختصار"/>
            </label>
          ) : null}
          {status === "pending" ? <p className="text-sm font-semibold text-amber-800">فيه سحب سابق لم يتأكد حفظه. استخدم نفس الكيس وأعد المحاولة، ولا تسحب نقدية جديدة.</p> : null}
          {error ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm font-semibold text-rose-800">{error}</p> : null}
          <button type="submit" disabled={saving}
            className="btn-primary min-h-12 w-full disabled:cursor-wait disabled:opacity-60">
            {saving ? "جارٍ الحفظ..." : decision === "collected" ? "تأكيد سحب النقدية" : "تسجيل تعذر السحب"}
          </button>
        </form>
      )}
    </section>
  );
}
