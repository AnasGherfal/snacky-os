"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Product = { id: string; name: string; sku: string | null; barcode: string | null; unit_price_lyd: number | null; machine_qty: number; bag_qty: number };
type Sale = { id: string; product_name: string; quantity: number; unit_price_lyd: number; total_lyd: number; stock_source: string; deposited_at: string; status: string; stock_posted: boolean };
type Workspace = { ok: boolean; task_id: string; machine_name: string; machine_id: string; can_sell: boolean; products: Product[]; sales: Sale[] };
type Command = { request_id: string; task_id: string; product_id: string; quantity: number; unit_price_lyd: number; stock_source: "machine" | "operator_bag"; notes: string; cash_in_machine: true; new_unrecorded_payment: true };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (n: number) => `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} LYD`;

export function RepairManualSales({ taskId, userId, ar }: { taskId: string; userId: string; ar: boolean }) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const router = useRouter();
  const key = `snacky:repair-cashbox-sale:v1:${userId}:${taskId}`;
  const [data, setData] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState("");
  const [source, setSource] = useState<"machine" | "operator_bag">("machine");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const [newPayment, setNewPayment] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);

  const load = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/operator/repair-sales?task_id=${taskId}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true || payload.task_id !== taskId || !Array.isArray(payload.products) || !Array.isArray(payload.sales)) {
        throw new Error(ar ? "تعذر تحميل المبيعات اليدوية لهذا الإصلاح." : "Could not load manual sales for this repair.");
      }
      setData(payload as Workspace); setLoadError("");
    } catch {
      setLoadError(ar ? "تعذر تحميل المبيعات. أعد المحاولة قبل إضافة بيع جديد." : "Could not load sales. Retry before adding another sale.");
    } finally { clearTimeout(timer); }
  }, [taskId, ar]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw) as Command;
        if (!uuid.test(saved.request_id) || saved.task_id !== taskId || !uuid.test(saved.product_id)
          || !["machine", "operator_bag"].includes(saved.stock_source) || !Number.isInteger(saved.quantity)
          || saved.cash_in_machine !== true || saved.new_unrecorded_payment !== true) throw new Error("Invalid saved sale");
        setPending(saved); setExpanded(true); setProductId(saved.product_id);
        setQuantity(saved.quantity); setSource(saved.stock_source); setNotes(saved.notes);
        setCashConfirmed(true); setNewPayment(true);
      }
    } catch {
      setBlocked(true);
      setMessage(ar ? "تعذر قراءة الطلب المحفوظ. اطلب مراجعة الإدارة قبل إعادة تسجيل البيع." : "Could not read the saved request. Ask management to check before recording this sale again.");
    }
    setReady(true);
  }, [key, taskId, ar]);

  const product = data?.products.find((p) => p.id === productId);
  const unitPrice = pending?.unit_price_lyd ?? Number(product?.unit_price_lyd ?? 0);
  const total = Math.round(quantity * unitPrice * 100) / 100;
  const available = source === "machine" ? Number(product?.machine_qty ?? 0) : Number(product?.bag_qty ?? 0);
  const matches = (data?.products ?? []).filter((p) =>
    [p.name, p.sku, p.barcode].join(" ").toLowerCase().includes(search.trim().toLowerCase())
  ).slice(0, 30);
  const locked = busy || Boolean(pending) || blocked || !ready || !data?.can_sell;
  const confirmed = (data?.sales ?? []).filter((s) => s.status === "confirmed");
  const cashTotal = confirmed.reduce((sum, s) => sum + Number(s.total_lyd), 0);

  async function save() {
    if (lock.current || blocked || !ready) return;
    if (!pending && (!data?.can_sell || !product || !Number.isInteger(quantity) || quantity < 1
      || quantity > available || unitPrice <= 0 || !cashConfirmed || !newPayment)) return;
    lock.current = true; setBusy(true); setMessage("");
    const command: Command = pending ?? {
      request_id: crypto.randomUUID(), task_id: taskId, product_id: productId,
      quantity, unit_price_lyd: unitPrice, stock_source: source, notes: notes.trim(),
      cash_in_machine: true, new_unrecorded_payment: true,
    };
    try {
      // Persist BEFORE sending. Never change the ID/payload of an uncertain sale.
      localStorage.setItem(key, JSON.stringify(command));
    } catch {
      setMessage(tr("Browser storage is unavailable. No request was sent. Enable storage and retry.", "تخزين المتصفح غير متاح. لم يُرسل الطلب. فعّل التخزين ثم أعد المحاولة."));
      lock.current = false; setBusy(false); return;
    }
    setPending(command);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/operator/repair-sales", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(command), cache: "no-store", signal: controller.signal,
      });
      const result = await response.json();
      if (response.ok && result?.ok === true && result.request_id === command.request_id
        && result.task_id === taskId && uuid.test(String(result.sale_id)) && result.cash_destination === "machine_cashbox") {
        localStorage.removeItem(key); setPending(null);
        setMessage(tr(`Saved: ${money(Number(result.total_lyd))} left in ${data?.machine_name ?? "the machine"}. Stock posted once.`, `تم الحفظ: ${money(Number(result.total_lyd))} داخل ${data?.machine_name ?? "الماكينة"}. تم خصم المخزون مرة واحدة.`));
        setProductId(""); setQuantity(1); setNotes(""); setCashConfirmed(false); setNewPayment(false); setSearch("");
        await load(); router.refresh();
      } else {
        if (result?.retryable === false) { localStorage.removeItem(key); setPending(null); await load(); }
        setMessage(String(result?.error ?? tr("Result uncertain. Retry the same saved sale.", "النتيجة غير مؤكدة. أعد نفس البيع المحفوظ.")));
      }
    } catch {
      setMessage(tr("Result uncertain. Retry this saved sale—not a new entry.", "النتيجة غير مؤكدة. أعد هذا البيع المحفوظ، ولا تنشئ بيعاً جديداً."));
    } finally { clearTimeout(timer); lock.current = false; setBusy(false); }
  }

  return <section className="rounded-xl border border-emerald-200 bg-white p-4" dir={ar ? "rtl" : "ltr"} data-testid="repair-manual-sales">
    <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 text-start" onClick={() => setExpanded((v) => !v)}>
      <span><strong className="block text-base text-slate-950">{tr("Manual sale during repair", "بيع يدوي أثناء الإصلاح")}</strong>
        <span className="mt-1 block text-xs text-slate-600">{tr("Cash must stay in this machine's cashbox.", "يجب ترك كامل المبلغ في صندوق نقود نفس الماكينة.")}</span></span>
      <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">{data ? money(cashTotal) : "…"}</span>
    </button>
    {loadError ? <p role="alert" className="mt-2 text-sm text-amber-900">{loadError} <button type="button" onClick={() => void load()} className="underline">{tr("Retry", "إعادة المحاولة")}</button></p> : null}
    {expanded ? <div className="mt-3 space-y-4 border-t border-slate-200 pt-4">
      <p className="text-sm font-semibold text-slate-950">{tr("Machine", "الماكينة")}: {data?.machine_name ?? "…"}</p>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{tr(
        "New payments only. Do not enter a sale already in XY or a product handed over for an earlier failed purchase. Put cash directly into the cashbox—not through the bill reader.",
        "للمبالغ الجديدة فقط. لا تسجّل بيعاً موجوداً في XY أو منتجاً سُلّم مقابل شراء سابق تعطل. ضع النقود مباشرة في الصندوق، وليس عبر قارئ العملة.",
      )}</p>
      {message ? <p role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">{message}</p> : null}
      {pending ? <p className="text-sm font-semibold text-amber-900">{tr("This sale is saved locally and locked until its result is confirmed. Retry below.", "البيع محفوظ على الجهاز ومقفل حتى تأكيد النتيجة. أعد المحاولة أدناه.")}</p> : null}
      {data && !data.can_sell && !pending ? <p className="text-sm text-slate-600">{tr("Only the assigned operator can add sales while the repair is in progress. Start work first.", "يمكن للمشغّل المسؤول إضافة المبيعات أثناء العمل على الإصلاح فقط. ابدأ العمل أولاً.")}</p> : null}
      {data?.can_sell || pending ? <div className="space-y-3">
        <label className="block text-sm font-medium">{tr("Stock physically taken from", "المصدر الفعلي للبضاعة")}
          <select className="field-input mt-1 min-h-12 w-full" value={source} disabled={locked} onChange={(e) => { setSource(e.target.value as "machine" | "operator_bag"); setCashConfirmed(false); }}>
            <option value="machine">{tr("This machine", "نفس الماكينة")}</option>
            <option value="operator_bag">{tr("My recorded operator bag", "البضاعة المسجّلة في عهدتي")}</option>
          </select>
        </label>
        <label className="block text-sm font-medium">{tr("Find product", "البحث عن المنتج")}
          <input type="search" className="field-input mt-1 min-h-12 w-full" disabled={locked} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr("Name, SKU or barcode", "اسم المنتج أو رمزه أو الباركود")} />
        </label>
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2" role="listbox" aria-label={tr("Products", "المنتجات")}>
          {matches.map((p) => <button key={p.id} type="button" role="option" aria-selected={p.id === productId} disabled={locked}
            className={`min-h-11 w-full rounded-md px-3 py-2 text-start text-sm disabled:opacity-60 ${p.id === productId ? "bg-emerald-100 font-bold text-emerald-950" : "hover:bg-slate-100"}`}
            onClick={() => { setProductId(p.id); setCashConfirmed(false); }}>
            {p.name}<span className="ms-2 text-xs text-slate-500">{money(Number(p.unit_price_lyd ?? 0))}</span>
          </button>)}
          {!matches.length ? <p className="p-2 text-sm text-slate-600">{tr("No matching product", "لا يوجد منتج مطابق")}</p> : null}
        </div>
        {product ? <p className="text-sm font-semibold">{product.name} · {tr("Recorded stock", "المخزون المسجّل")}: {available}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">{tr("Quantity sold", "الكمية المباعة")}<input className="field-input mt-1 min-h-12 w-full" type="number" inputMode="numeric" min={1} step={1} max={Math.min(500, available)} value={quantity} disabled={locked} onChange={(e) => { setQuantity(Number(e.target.value)); setCashConfirmed(false); }} /></label>
          <div className="rounded-lg bg-emerald-50 p-3"><span className="text-xs text-emerald-800">{tr("Cash to leave in the machine", "المبلغ الواجب تركه في الماكينة")}</span><strong className="mt-1 block text-lg text-emerald-950">{money(total)}</strong></div>
        </div>
        <p className="text-xs text-slate-600">{tr("The configured product price is used. No stock is taken from storage automatically.", "يُستخدم سعر المنتج المعتمد. لا تُخصم البضاعة تلقائياً من المخزن.")}</p>
        {source === "machine" ? <p className="text-xs font-medium text-amber-900">{tr("Snacky posts the stock movement. Also check the final physical lane quantity in XY; this form does not send an XY quantity command.", "يسجّل سناكي حركة المخزون. راجع أيضاً العدد الفعلي المتبقي بالخانة في XY؛ هذا النموذج لا يرسل أمر تعديل كمية إلى XY.")}</p> : null}
        <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" disabled={locked} checked={newPayment} onChange={(e) => setNewPayment(e.target.checked)} /><span>{tr("This is a new cash payment, not already recorded in XY or paid earlier.", "هذا مبلغ نقدي جديد، غير مسجّل في XY ولم يُدفع مسبقاً.")}</span></label>
        <label className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-semibold"><input type="checkbox" className="mt-1 size-5 shrink-0" disabled={locked} checked={cashConfirmed} onChange={(e) => setCashConfirmed(e.target.checked)} /><span>{tr(`I left the full ${money(total)} in this machine's cashbox.`, `تركت كامل مبلغ ${money(total)} في صندوق نقود نفس الماكينة.`)}</span></label>
        <label className="block text-sm">{tr("Note (optional)", "ملاحظة (اختياري)")}<textarea className="field-input mt-1 w-full" rows={2} maxLength={2000} disabled={locked} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button type="button" className="btn-primary min-h-12 w-full" onClick={() => void save()} disabled={busy || blocked || !ready || (!pending && (!product || quantity < 1 || quantity > available || !Number.isInteger(quantity) || unitPrice <= 0 || !cashConfirmed || !newPayment || Boolean(loadError)))}>
          {busy ? tr("Saving…", "جارٍ الحفظ…") : pending ? tr("Retry saved sale", "إعادة محاولة البيع المحفوظ") : tr("Record sale — cash left in machine", "تسجيل البيع — النقد داخل الماكينة")}
        </button>
      </div> : null}
      {data?.sales.length ? <div className="space-y-2">
        <h3 className="text-sm font-bold">{tr("Sales recorded for this repair", "مبيعات هذا الإصلاح")}</h3>
        {data.sales.map((sale) => <div key={sale.id} className="rounded-lg border border-slate-200 p-3 text-sm">
          <strong>{sale.quantity} × {sale.product_name} — {money(Number(sale.total_lyd))}</strong>
          <p className="mt-1 text-xs text-slate-600">{tr("Cash left in this machine", "النقد متروك داخل هذه الماكينة")} · {sale.stock_source === "machine" ? tr("Machine stock", "مخزون الماكينة") : tr("Operator bag", "عهدة المشغّل")}</p>
          <p className="mt-1 text-xs text-slate-500">{new Date(sale.deposited_at).toLocaleString(ar ? "ar-LY" : "en-GB", { timeZone: "Africa/Tripoli" })}</p>
        </div>)}
      </div> : null}
    </div> : null}
  </section>;
}
