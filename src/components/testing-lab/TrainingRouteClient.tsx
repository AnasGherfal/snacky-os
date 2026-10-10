"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { GuidedMachineCamera } from "@/components/testing-lab/GuidedMachineCamera";
import { MachineStockQuickEditor, type QuickMachineRow } from "@/components/operator/MachineStockQuickEditor";
import { groupMachineLayoutRows } from "@/lib/xy-machine-layout-groups";

type Product = { id: string; en: string; ar: string };
type Lane = {
  code: string;
  productId: string;
  originalProductId: string;
  initialQty: number;
  plannedAdd: number;
  actualAdd: number;
  capacity: number;
  xyQty: number;
  xyProductId: string;
  priceLyd: number;
  oldStockHandled: boolean;
};
type Stop = {
  id: string;
  name: string;
  location: string;
  machineCode: string;
  status: "assigned" | "in_progress" | "completed";
  xyPending: boolean;
  pendingReason: string;
  cleaningDone: boolean;
  photoReady: boolean;
  note: string;
  verifiedAt: string | null;
  issues: string[];
  lanes: Lane[];
};
type TrainingState = {
  started: boolean;
  pickupConfirmed: boolean;
  pickup: Record<string, number>;
  stops: Stop[];
  routeCompleted: boolean;
};
type ErrorItem = { slotCode: string; reason: "product_mismatch" | "quantity_mismatch"; expected: number; xy: number };

const PRODUCTS: Product[] = [
  { id: "cola", en: "Coca-Cola", ar: "كوكاكولا" },
  { id: "water", en: "Water", ar: "مياه" },
  { id: "snickers", en: "Snickers", ar: "سنيكرز" },
  { id: "pepsi", en: "Pepsi", ar: "بيبسي" },
  { id: "juice", en: "Juice", ar: "عصير" },
];
const START: Stop[] = [
  {
    id: "1", name: "HT Mall", location: "Tripoli", machineCode: "SN-TRAIN-01",
    status: "assigned", xyPending: false, pendingReason: "", cleaningDone: false,
    photoReady: false, verifiedAt: null, note: "", issues: [],
    lanes: [
      { code: "001", productId: "cola", originalProductId: "cola", initialQty: 2, plannedAdd: 6, actualAdd: 0, capacity: 10, xyQty: 2, xyProductId: "cola", priceLyd: 4, oldStockHandled: false },
      { code: "003", productId: "cola", originalProductId: "cola", initialQty: 0, plannedAdd: 8, actualAdd: 0, capacity: 10, xyQty: 0, xyProductId: "cola", priceLyd: 4, oldStockHandled: false },
      { code: "005", productId: "water", originalProductId: "water", initialQty: 3, plannedAdd: 5, actualAdd: 0, capacity: 10, xyQty: 3, xyProductId: "water", priceLyd: 3, oldStockHandled: false },
      { code: "007", productId: "snickers", originalProductId: "snickers", initialQty: 1, plannedAdd: 5, actualAdd: 0, capacity: 10, xyQty: 1, xyProductId: "snickers", priceLyd: 5, oldStockHandled: false },
    ],
  },
  {
    id: "2", name: "Almouasafat Hospital", location: "Tripoli", machineCode: "SN-TRAIN-02",
    status: "assigned", xyPending: false, pendingReason: "", cleaningDone: false,
    photoReady: false, verifiedAt: null, note: "", issues: [],
    lanes: [
      { code: "011", productId: "juice", originalProductId: "juice", initialQty: 0, plannedAdd: 6, actualAdd: 0, capacity: 10, xyQty: 0, xyProductId: "juice", priceLyd: 5, oldStockHandled: false },
      { code: "012", productId: "snickers", originalProductId: "snickers", initialQty: 0, plannedAdd: 5, actualAdd: 0, capacity: 10, xyQty: 0, xyProductId: "snickers", priceLyd: 5, oldStockHandled: false },
    ],
  },
  {
    id: "3", name: "Diplomacy Mall", location: "Tripoli", machineCode: "SN-TRAIN-03",
    status: "assigned", xyPending: false, pendingReason: "", cleaningDone: false,
    photoReady: false, verifiedAt: null, note: "", issues: [],
    lanes: [
      { code: "021", productId: "water", originalProductId: "water", initialQty: 0, plannedAdd: 8, actualAdd: 0, capacity: 10, xyQty: 0, xyProductId: "pepsi", priceLyd: 3, oldStockHandled: false },
      { code: "022", productId: "pepsi", originalProductId: "pepsi", initialQty: 0, plannedAdd: 6, actualAdd: 0, capacity: 10, xyQty: 0, xyProductId: "pepsi", priceLyd: 4, oldStockHandled: false },
    ],
  },
];
const makeInitial = (): TrainingState => ({
  started: false,
  pickupConfirmed: false,
  pickup: PRODUCTS.reduce<Record<string, number>>((out, product) => {
    out[product.id] = START.flatMap((stop) => stop.lanes)
      .filter((lane) => lane.productId === product.id).reduce((sum, lane) => sum + lane.plannedAdd, 0);
    return out;
  }, {}),
  stops: structuredClone(START),
  routeCompleted: false,
});

const expectedFinal = (lane: Lane) => (lane.productId === lane.originalProductId ? lane.initialQty : 0) + lane.actualAdd;
const compare = (stop: Stop): ErrorItem[] => stop.lanes.flatMap((lane) => {
  // Explicit per-lane identity: two Coca-Cola selections cannot cancel each other's mismatch.
  const expected = expectedFinal(lane);
  if (lane.xyProductId !== lane.productId) {
    return [{ slotCode: lane.code, reason: "product_mismatch" as const, expected, xy: lane.xyQty }];
  }
  if (lane.xyQty !== expected) {
    return [{ slotCode: lane.code, reason: "quantity_mismatch" as const, expected, xy: lane.xyQty }];
  }
  return [];
});
const taken = (state: TrainingState) => {
  const quantities: Record<string, number> = {};
  for (const stop of state.stops) {
    if (stop.status !== "completed") continue;
    for (const lane of stop.lanes) {
      quantities[lane.productId] = (quantities[lane.productId] ?? 0) + lane.actualAdd;
    }
  }
  return quantities;
};

export function TrainingRouteClient() {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [state, setState] = useState<TrainingState>(makeInitial);
  const [screen, setScreen] = useState<"overview" | "pickup" | "stop" | "leftovers">("overview");
  const [index, setIndex] = useState(0);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedFinals, setSelectedFinals] = useState<Record<string, number>>({});
  const [selectedPrices, setSelectedPrices] = useState<Record<string, number>>({});
  const [selectedProducts, setSelectedProducts] = useState<Record<string, string>>({});
  const [saveStatuses, setSaveStatuses] = useState<Record<string, { status: "verified" | "error"; message: string }>>({});
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [showCash, setShowCash] = useState(false);
  const [sampleCash, setSampleCash] = useState("");
  const [cashSubmitted, setCashSubmitted] = useState(false);

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const activeStop = state.stops[index];
  const completed = state.stops.filter((stop) => stop.status === "completed").length;
  const pickedPlan = useMemo(() => {
    const summary: Record<string, number> = {};
    for (const stop of state.stops) for (const lane of stop.lanes)
      summary[lane.productId] = (summary[lane.productId] ?? 0) + lane.plannedAdd;
    return summary;
  }, [state.stops]);

  const used = useMemo(() => taken(state), [state]);
  const bagAvailable = (productId: string, includingCurrentDraft = false) =>
    (state.pickup[productId] ?? 0) - (used[productId] ?? 0)
    - (includingCurrentDraft ? activeStop.lanes.filter((lane) => lane.productId === productId)
      .reduce((sum, lane) => sum + lane.actualAdd, 0) : 0);
  const conflicts = compare(activeStop);
  const allFilled = activeStop.lanes.reduce((sum, lane) => sum + lane.actualAdd, 0);
  const shortages = activeStop.lanes.filter((lane) => lane.actualAdd < lane.plannedAdd);
  const trainingRows: QuickMachineRow[] = useMemo(() => {
    const slots = activeStop.lanes.map((lane) => ({
      slotCode: lane.code,
      productName: PRODUCTS.find((p) => p.id === lane.xyProductId)?.[ar ? "ar" : "en"] ?? lane.xyProductId,
      currentQty: lane.xyQty, capacity: lane.capacity,
      vmsProductId: lane.xyProductId, productId: lane.xyProductId,
      priceLyd: lane.priceLyd, liveStockKnown: true,
    }));
    return groupMachineLayoutRows(slots);
  }, [activeStop.lanes, ar]);

  const go = (screenName: typeof screen, stopIndex = index) => {
    setScreen(screenName);
    setIndex(stopIndex);
    setFormError("");
    setNotice("");
    setSelectedFinals({});
    setSelectedProducts({});
    setSelectedPrices({});
    setSaveStatuses({});
    setShowIssue(false);
    setIssueText("");
    setShowCash(false);
    setSampleCash("");
    setCashSubmitted(false);
    setPhotoUrl(null);
  };

  const reset = () => { setState(makeInitial()); go("overview", 0); };
  const updateStop = (change: (stop: Stop) => Stop) => setState((prev) => ({
    ...prev, stops: prev.stops.map((stop, i) => i === index ? change(stop) : stop),
  }));
  const updateLane = (code: string, patch: Partial<Lane>) =>
    updateStop((stop) => ({
      ...stop, verifiedAt: null, xyPending: false, lanes: stop.lanes.map((lane) => lane.code === code ? { ...lane, ...patch } : lane),
    }));
  const label = (productId: string) => PRODUCTS.find((product) => product.id === productId)?.[ar ? "ar" : "en"] ?? productId;

  const startRoute = () => { setState((prev) => ({ ...prev, started: true })); go("pickup"); };
  const confirmPickup = () => {
    if (!PRODUCTS.every((p) => Number.isSafeInteger(state.pickup[p.id]) && state.pickup[p.id] >= 0)) {
      setFormError(tr("Enter valid pickup quantities.", "أدخل كميات استلام صحيحة.")); return;
    }
    setState((prev) => ({ ...prev, pickupConfirmed: true }));
    go("overview");
    setNotice(tr("Pickup saved to the simulated operator bag.", "تم حفظ الاستلام في شنطة المشغل التجريبية."));
  };
  const changeFill = (code: string, quantity: number) => {
    const lane = activeStop.lanes.find((s) => s.code === code);
    if (!lane || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > lane.capacity - (lane.productId === lane.originalProductId ? lane.initialQty : 0)) return;
    const available = bagAvailable(lane.productId, true) + lane.actualAdd;
    if (quantity > available) {
      setFormError(tr("Not enough units in the operator bag. Reduce this fill or correct your pickup.", "الكمية في شنطة المشغل مش كافية. قلل التعبئة أو صحح الاستلام.")); return;
    }
    setFormError("");
    updateLane(code, { actualAdd: quantity });
  };

  const saveSelection = (code: string) => {
    const lane = activeStop.lanes.find((row) => row.code === code);
    if (!lane) return;
    const product = selectedProducts[code] ?? lane.xyProductId;
    const requested = Object.hasOwn(selectedFinals, code) ? selectedFinals[code] : lane.xyQty;
    const price = Object.hasOwn(selectedPrices, code) ? selectedPrices[code] : lane.priceLyd;
    const switching = product !== lane.xyProductId;
    if (switching && !lane.oldStockHandled) {
      setFormError(tr("Record and confirm handling of any old products before changing this selection.", "تأكد من سحب وتسجيل المنتجات القديمة قبل تغيير الخانة.")); return;
    }
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > lane.capacity || !Number.isFinite(price) || price <= 0) {
      setFormError(tr("Check the final quantity and selling price.", "راجع الكمية النهائية وسعر البيع.")); return;
    }
    if (!Object.hasOwn(selectedFinals, code) && !switching && !Object.hasOwn(selectedPrices, code)) {
      setFormError(tr("Choose a quantity, price or product before saving.", "غيّر الكمية أو السعر أو المنتج أولاً.")); return;
    }
    updateLane(code, { xyQty: requested, xyProductId: product, priceLyd: price });
    setSelectedFinals((current) => { const next = { ...current }; delete next[code]; return next; });
    setSelectedPrices((current) => { const next = { ...current }; delete next[code]; return next; });
    setSelectedProducts((current) => { const next = { ...current }; delete next[code]; return next; });
    setSaveStatuses((prev) => ({
      ...prev, [code]: { status: "verified", message: tr("Simulated XY selection saved", "تم حفظ الخانة في XY التجريبي") },
    }));
    setFormError("");
  };

  const verify = () => {
    const found = compare(activeStop);
    if (found.length) {
      setFormError(tr(
        \`\${found.length} selections still disagree with XY. Correct only those selections or record an explicit pending exception.\`,
        \`يوجد اختلاف في \${found.length} خانات عن XY. صحح الخانات أو سجّل استثناء معلق صراحةً.\`,
      ));
      updateStop((stop) => ({ ...stop, verifiedAt: null }));
    } else {
      updateStop((stop) => ({ ...stop, verifiedAt: new Date().toISOString(), xyPending: false }));
      setFormError("");
      setNotice(tr("All selections verified against the simulated XY inventory.", "كل الخانات مطابقة لمخزون XY التجريبي."));
    }
  };
  const completeStop = () => {
    if (!activeStop.photoReady) { setFormError(tr("Save the final machine photo first.", "احفظ صورة الماكينة النهائية أولاً.")); return; }
    if (!activeStop.cleaningDone) { setFormError(tr("Complete the cleaning and compressor check.", "أكمل فحص التنظيف وتشغيل الضاغط.")); return; }
    if (!activeStop.verifiedAt && !(activeStop.xyPending && activeStop.pendingReason.trim().length >= 3)) {
      setFormError(tr("Refresh and verify XY or document why it is pending.", "تحقق من XY أو اكتب سبب بقاء المزامنة معلقة.")); return;
    }
    if (shortages.length && !activeStop.note.trim()) {
      setFormError(tr("Record a reason for the products you did not fill.", "اكتب سبب المنتجات اللي ما تمتش تعبئتها.")); return;
    }
    updateStop((stop) => ({ ...stop, status: "completed" }));
    go("overview");
    setNotice(tr("Stop completed; operator bag balance updated in training only.", "تم إنهاء الموقع؛ رصيد شنطة المشغل تحدّث في التدريب فقط."));
  };

  return (
    <section id="training-route" dir={ar ? "rtl" : "ltr"} className="overflow-hidden rounded-3xl border-2 border-slate-200 bg-slate-50 shadow-sm">
      <div className="bg-emerald-950 p-4 text-white sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-amber-300">SNACKY · OPERATOR TRAINING</p>
            <h2 className="mt-2 text-xl font-extrabold sm:text-2xl">{tr("Training route — operator experience", "جولة تدريبية — تجربة المشغل")}</h2>
            <p className="mt-1 text-sm text-emerald-100">{tr("Use the same machine selection editor and camera patterns as Snacky OS. Training data is local to this browser — never a real route.", "استخدم نفس محرر خانات الماكينة والكاميرا. البيانات تجريبية داخل المتصفح فقط ومش جولة حقيقية.")}</p>
          </div>
          <span className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-black text-amber-300">{tr("TRAINING ONLY", "تدريب فقط")}</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-white/10 p-3"><div className="text-xl font-bold">3</div><p className="text-xs text-emerald-100">{tr("Stops", "المواقع")}</p></div>
          <div className="rounded-xl bg-white/10 p-3"><div className="text-xl font-bold">{completed}/3</div><p className="text-xs text-emerald-100">{tr("Completed", "مكتملة")}</p></div>
          <div className="rounded-xl bg-white/10 p-3"><div className="text-xl font-bold">{state.pickupConfirmed ? tr("Picked", "مستلمة") : tr("Pending", "معلقة")}</div><p className="text-xs text-emerald-100">{tr("Route stock", "بضاعة الجولة")}</p></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white p-3">
        <button type="button" className="btn-secondary text-sm" onClick={() => go("overview")}>{tr("Route", "الجولة")}</button>
        <button type="button" className="btn-secondary text-sm" onClick={() => go("pickup")}>{tr("Pickup", "الاستلام")}</button>
        <button type="button" className="btn-secondary text-sm" onClick={() => go("leftovers")}>{tr("Bag / leftovers", "الشنطة / البواقي")}</button>
        <button type="button" className="ms-auto rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800" onClick={reset}>{tr("Reset training", "إعادة التدريب")}</button>
      </div>
      <div className="space-y-4 p-3 sm:p-5">
        {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-900">{notice}</p> : null}
        {formError ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-800">{formError}</p> : null}

        {screen === "overview" ? (
          <>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xl font-bold text-slate-950">{tr("Today's route", "جولة اليوم")} · TRAIN-001</h3>
                  <p className="mt-1 text-sm text-slate-600">{tr("Assigned to: Training operator · Tripoli", "مُسندة إلى: مشغل تدريبي · طرابلس")}</p>
                </div>
                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900">{state.routeCompleted ? tr("Completed", "مكتملة") : completed ? tr("In progress", "قيد التنفيذ") : tr("Assigned", "مسندة")}</span>
              </div>
              {!state.started ? <button type="button" className="btn-primary mt-4 w-full" onClick={startRoute}>{tr("Start route", "بدء الجولة")}</button> : null}
              {state.started && !state.pickupConfirmed ? <button type="button" className="btn-primary mt-4 w-full" onClick={() => go("pickup")}>{tr("Open pickup list", "فتح قائمة الاستلام")}</button> : null}
            </div>
            {state.stops.map((stop, i) => (
              <div key={stop.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-slate-500">{tr("STOP", "موقع")} {i + 1} · {stop.machineCode}</p>
                    <h4 className="mt-1 text-lg font-bold text-slate-950">{stop.name}</h4>
                    <p className="text-sm text-slate-500">{stop.location} · {stop.lanes.length} {tr("selections", "خانات")}</p>
                  </div>
                  <span className={\`h-fit rounded-full px-3 py-1 text-xs font-semibold \${stop.status === "completed" ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-700"}\`}>
                    {stop.status === "completed" ? tr("Completed", "مكتمل") : stop.status === "in_progress" ? tr("In progress", "قيد التنفيذ") : tr("Assigned", "مسند")}
                  </span>
                </div>
                {stop.xyPending ? <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{tr("XY verification pending — follow-up required", "التحقق من XY معلق — يحتاج متابعة")}</p> : null}
                <button type="button" disabled={!state.pickupConfirmed || stop.status === "completed"}
                  className="btn-primary mt-3 w-full disabled:opacity-40"
                  onClick={() => { updateStop(() => stop); go("stop", i); setState((prev) => ({ ...prev, stops: prev.stops.map((s,j) => j === i ? { ...s, status: "in_progress" } : s) })); }}>
                  {stop.status === "completed" ? tr("Stop completed", "تم إنهاء الموقع") : tr("Open / start stop", "فتح / بدء الموقع")}
                </button>
              </div>
            ))}
            {state.pickupConfirmed && completed === 3 && !state.routeCompleted ? (
              <button type="button" className="btn-primary w-full" onClick={() => go("leftovers")}>{tr("Finish route — reconcile leftovers", "إنهاء الجولة — مراجعة البواقي")}</button>
            ) : null}
            {state.routeCompleted ? <p className="rounded-xl bg-emerald-100 p-4 text-center font-bold text-emerald-900">{tr("Training route completed successfully", "اكتملت الجولة التدريبية بنجاح")}</p> : null}
          </>
        ) : null}

        {screen === "pickup" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase text-slate-500">{tr("Step 1 · Warehouse", "الخطوة 1 · المخزن")}</p>
            <h3 className="mt-1 text-xl font-bold">{tr("Pickup checklist", "قائمة استلام المنتجات")}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{tr("Count actual items taken from storage. They enter the simulated operator bag only on Confirm Pickup.", "احسب الكمية المستلمة فعلياً من المخزن. تدخل شنطة المشغل التجريبية فقط عند تأكيد الاستلام.")}</p>
            <div className="mt-4 space-y-3">
              {PRODUCTS.filter((p) => (pickedPlan[p.id] ?? 0) > 0).map((product) => (
                <label key={product.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                  <span className="min-w-0 text-sm font-bold text-slate-900">{product[ar ? "ar" : "en"]}<span className="block text-xs font-normal text-slate-500">{tr("Planned", "المخطط")}: {pickedPlan[product.id]}</span></span>
                  <input type="number" min={0} max={100} inputMode="numeric"
                    disabled={state.pickupConfirmed} value={state.pickup[product.id] ?? 0}
                    onChange={(event) => setState((prev) => ({ ...prev, pickup: { ...prev.pickup, [product.id]: Math.max(0, Math.min(100, Number(event.target.value) || 0)) } }))}
                    className="field-input w-24 text-center text-lg font-bold" aria-label={tr(\`\${product.en} picked quantity\`, \`كمية استلام \${product.ar}\`)} />
                </label>
              ))}
            </div>
            {state.pickupConfirmed ? <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-900">{tr("Pickup confirmed. Inventory is simulated, not deducted from storage.", "تم تأكيد الاستلام. المخزون تجريبي وما ينقصش من المخزن الحقيقي.")}</p> :
              <button type="button" className="btn-primary mt-4 w-full" onClick={confirmPickup}>{tr("Confirm pickup", "تأكيد الاستلام")}</button>}
          </section>
        ) : null}

        {screen === "stop" ? (
          <>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-bold text-slate-500">{tr("STOP", "الموقع")} {index + 1} · {activeStop.machineCode}</p>
              <h3 className="mt-1 text-2xl font-bold text-slate-950">{activeStop.name}</h3>
              <p className="mt-1 text-sm text-slate-600">{tr("Record what you actually filled, then update XY and finish.", "سجّل ما عبّيته فعلياً، وبعدها حدّث XY وأنهِ الموقع.")}</p>
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs font-bold text-amber-900">{tr("TRAINING MODE: actions change this simulated route only. No real vendor request, inventory movement, or cash posting.", "وضع التدريب: كل الإجراءات على الجولة التجريبية فقط، ولا يتم إرسال أوامر للماكينات أو تسجيل مخزون أو نقدية.")}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-lg font-bold">{tr("Actual refill", "التعبئة الفعلية")}</h4>
              <p className="mt-1 text-sm text-slate-600">{tr("Enter how many units you placed in EACH selection. Use 0 for a missed product.", "أدخل عدد القطع اللي عبّيتها في كل خانة. لو ما عبّيتهاش خليه 0.")}</p>
              <div className="mt-4 space-y-2">
                {activeStop.lanes.map((lane) => (
                  <div key={lane.code} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-500">{tr("Selection", "الخانة")} {lane.code}</div>
                      <div className="text-sm font-bold text-slate-950">{label(lane.productId)}</div>
                      <div className="text-xs text-slate-500">{tr("Planned", "المخطط")} {lane.plannedAdd} · {tr("Existing", "الموجود")} {lane.initialQty} · {tr("In bag", "بالشنطة")} {bagAvailable(lane.productId, true) + lane.actualAdd}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" className="h-11 w-11 rounded-lg border border-slate-300 text-lg font-bold" onClick={() => changeFill(lane.code, lane.actualAdd - 1)} disabled={lane.actualAdd <= 0}>−</button>
                      <input type="number" inputMode="numeric" min={0} max={lane.capacity}
                        className="field-input w-16 text-center text-lg font-bold" value={lane.actualAdd}
                        onChange={(event) => changeFill(lane.code, Number(event.target.value) || 0)} />
                      <button type="button" className="h-11 w-11 rounded-lg border border-slate-300 text-lg font-bold" onClick={() => changeFill(lane.code, lane.actualAdd + 1)}>+</button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm font-semibold">{tr("Filled now", "تعبئة الآن")}: {allFilled} {tr("units", "قطعة")} · {tr("Products not fully filled", "منتجات ناقصة")}: {shortages.length}</p>
              <label className="mt-3 block text-sm font-semibold text-slate-700">{tr("Notes / shortage reason", "ملاحظات / سبب النقص")}
                <textarea value={activeStop.note} onChange={(event) => updateStop((stop) => ({ ...stop, note: event.target.value }))}
                  className="field-input mt-1 min-h-20" placeholder={tr("Why was something missing or changed?", "علاش فيه نقص أو تغيير؟")} />
              </label>
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
              <strong>{tr("XY selection stock — training", "مخزون خانات XY — تدريب")}</strong>
              <p className="mt-1 text-xs">{tr("The editor below is the same machine-selection editor used in operator stops. Save a selection to simulate an XY update.", "محرر الخانات تحت هو نفسه الموجود عند المشغل. احفظ أي خانة لمحاكاة تحديث XY.")}</p>
              <p className="mt-1 text-xs">{tr("Read time", "وقت القراءة")}: {new Date().toLocaleTimeString(ar ? "ar-LY" : "en-GB")} · {tr("SIMULATED, not live", "تجريبي، مش مباشر")}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <h4 className="mb-3 font-bold">{tr("Replacement product", "تغيير المنتج")}</h4>
              <p className="mb-3 text-xs text-slate-600">{tr("Before changing a lane product, account for any old items and confirm the physical replacement.", "قبل تغيير المنتج في الخانة، سجّل وسلّم المنتج القديم وتأكد من التعبئة الجديدة.")}</p>
              {activeStop.lanes.map((lane) => (
                <label key={lane.code} className="mb-2 flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={lane.oldStockHandled} onChange={(event) => updateLane(lane.code, { oldStockHandled: event.target.checked })} />
                  {tr("Selection", "الخانة")} {lane.code} · {tr("Old product returned / handled", "المنتج القديم رجّعته / تعاملت معاه")}
                </label>
              ))}
            </div>

            <MachineStockQuickEditor
              rows={trainingRows}
              values={selectedFinals}
              onChange={setSelectedFinals}
              prices={selectedPrices}
              onPriceChange={setSelectedPrices}
              productOptions={PRODUCTS.map((product) => ({ id: product.id, name: product[ar ? "ar" : "en"] }))}
              productSelections={selectedProducts}
              onSelectProduct={(code, product) => setSelectedProducts((old) => ({ ...old, [code]: product }))}
              onSaveSelection={saveSelection}
              saveStatuses={saveStatuses}
              isLiveXy
            />

            <div className="rounded-2xl border border-slate-200 bg-white p-4" id="training-xy-verify">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-lg font-bold">{tr("Refill verification", "التحقق من التعبئة")}</h4>
                <span className={\`rounded-full px-3 py-1 text-xs font-bold \${activeStop.verifiedAt ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}\`}>
                  {activeStop.verifiedAt ? tr("Verified", "مطابق") : tr("Not verified", "غير مؤكد")}
                </span>
              </div>
              <button type="button" onClick={verify} className="btn-primary mt-3 w-full">{tr("Refresh & verify XY (training)", "تحديث القراءة والتحقق من XY (تدريب)")}</button>
              {conflicts.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <p className="font-bold text-rose-800">{tr(\`\${conflicts.length} selections need correction\`, \`\${conflicts.length} خانات تحتاج تصحيح\`)}</p>
                  {conflicts.map((conflict) => <div key={conflict.slotCode} className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
                    <strong>{tr("Selection", "الخانة")} {conflict.slotCode}</strong>
                    <div>{conflict.reason === "product_mismatch" ? tr("Product mismatch", "المنتج غلط في XY") : tr("Quantity mismatch", "الكمية مختلفة")}</div>
                    <div>{tr("Expected", "المتوقع")} {conflict.expected} · XY {conflict.xy}</div>
                  </div>)}
                </div>
              ) : activeStop.verifiedAt ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-900">{tr("All selections match simulated XY.", "كل الخانات مطابقة لـ XY التجريبي.")}</p> : null}
              <details className="mt-3 rounded-lg border border-amber-200 p-3">
                <summary className="cursor-pointer text-sm font-bold">{tr("XY unavailable? Record pending verification", "XY مش متصل؟ سجّل التحقق المعلق")}</summary>
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={activeStop.xyPending} onChange={(e) => updateStop((stop) => ({ ...stop, xyPending: e.target.checked, verifiedAt: null }))} className="mt-1" />
                  {tr("Finish with an explicit unresolved XY exception", "إنهاء الموقع مع استثناء XY غير محسوم")}
                </label>
                <textarea value={activeStop.pendingReason} onChange={(event) => updateStop((stop) => ({ ...stop, pendingReason: event.target.value }))}
                  className="field-input mt-2" placeholder={tr("State reason: power off, connection, stale reading...", "اكتب السبب: كهرباء مقطوعة، اتصال ضعيف، قراءة قديمة...")} />
              </details>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-lg font-bold">{tr("Refill proof", "إثبات التعبئة")}</h4>
              <p className="mt-1 text-xs text-slate-600">{tr("Use the real guided camera or choose a library photo. Saved only in this browser's training state.", "استعمل كاميرا الإطار أو صورة من مكتبتك. تُحفظ محلياً في المتصفح للتدريب فقط.")}</p>
              <div className="mt-3">
                <GuidedMachineCamera disabled={false} selectionRowCount={trainingRows.length || 4} onCaptured={async (file) => {
                  setPhotoUrl(URL.createObjectURL(file));
                  updateStop((stop) => ({ ...stop, photoReady: true }));
                  return true;
                }} />
              </div>
              <label className="mt-3 block rounded-xl border border-dashed border-slate-300 p-3 text-center text-sm font-bold text-emerald-900">
                {tr("Or choose a machine photo from library", "أو اختر صورة الماكينة من الألبوم")}
                <input type="file" accept="image/*" className="mt-2 block w-full text-sm text-slate-600"
                  onChange={(event) => {
                    const file = event.target.files?.[0]; event.target.value = "";
                    if (!file) return;
                    setPhotoUrl(URL.createObjectURL(file));
                    updateStop((stop) => ({ ...stop, photoReady: true }));
                  }} />
              </label>
              {photoUrl ? (
                <div className="mt-3 rounded-xl bg-emerald-50 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl} alt={tr("Training proof photo", "صورة تدريبية للماكينة")} className="max-h-64 w-full object-contain" />
                  <p className="mt-2 text-sm font-bold text-emerald-900">{tr("Training proof photo saved locally", "تم حفظ صورة التدريب محلياً")}</p>
                </div>
              ) : activeStop.photoReady ? <p className="mt-2 text-xs text-emerald-900">{tr("Proof recorded for this training stop", "صورة الإثبات محفوظة لهذا الموقع التجريبي")}</p> : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-lg font-bold">{tr("Cash and issues", "النقدية والمشاكل")}</h4>
              <p className="text-sm text-slate-600">{tr("Cash is recorded separately from refill completion, as on real routes.", "سحب النقد يتم بشكل منفصل عن إنهاء التعبئة، مثل الجولة الحقيقية.")}</p>
              <button type="button" className="btn-secondary mt-2" onClick={() => setShowCash((v) => !v)}>{tr("Practice cash removal", "تجربة سحب النقدية")}</button>
              {showCash ? <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
                <input type="number" inputMode="decimal" value={sampleCash} placeholder={tr("Cash amount (LYD)", "المبلغ (د.ل)")}
                  onChange={(e) => setSampleCash(e.target.value)} className="field-input" />
                <button type="button" className="btn-secondary" onClick={() => {
                  if (Number(sampleCash) < 0 || !Number.isFinite(Number(sampleCash)) || !sampleCash) {
                    setFormError(tr("Enter a valid cash amount.", "أدخل مبلغ صحيح.")); return;
                  }
                  setCashSubmitted(true); setFormError("");
                }}>{tr("Save simulated cash removal", "حفظ سحب نقدي تجريبي")}</button>
                {cashSubmitted ? <p className="text-xs font-bold text-emerald-900">{tr("Cash saved for training only.", "سجل النقدية في التدريب فقط.")}</p> : null}
              </div> : null}
              <button type="button" className="btn-secondary mt-2" onClick={() => setShowIssue((v) => !v)}>{tr("Report an issue", "الإبلاغ عن مشكلة")}</button>
              {showIssue ? <div className="mt-2 space-y-2">
                <textarea className="field-input" value={issueText} onChange={(e) => setIssueText(e.target.value)} placeholder={tr("Describe the issue", "وصف المشكلة")} />
                <button type="button" className="btn-secondary" onClick={() => {
                  if (!issueText.trim()) return;
                  updateStop((stop) => ({ ...stop, issues: [...stop.issues, issueText.trim()] }));
                  setIssueText(""); setShowIssue(false);
                }}>{tr("Save issue in training", "حفظ المشكلة في التدريب")}</button>
              </div> : null}
              {activeStop.issues.length ? <p className="mt-2 text-xs text-amber-900">{tr("Issues reported", "المشاكل المسجلة")}: {activeStop.issues.join("; ")}</p> : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-lg font-bold">{tr("Cleaning and final check", "التنظيف والفحص النهائي")}</h4>
              <label className="mt-3 flex items-start gap-3 text-sm text-slate-800">
                <input type="checkbox" checked={activeStop.cleaningDone}
                  onChange={(event) => updateStop((stop) => ({ ...stop, cleaningDone: event.target.checked }))}
                  className="mt-1 h-5 w-5 accent-emerald-700" />
                {tr("Exterior clean, display working, compressor on, product rows arranged, and no visible damaged/expired items.", "الماكينة نظيفة والشاشة شغالة والضاغط شغال والمنتجات مرتبة وما فيش منتجات تالفة أو منتهية.")}
              </label>
            </div>

            <div className="sticky bottom-3 z-20 rounded-xl border border-emerald-200 bg-white/95 p-3 shadow-lg backdrop-blur">
              <button type="button" className="btn-primary w-full" onClick={completeStop}>{tr("Complete Stop", "إنهاء الموقع")}</button>
              <button type="button" className="mt-2 w-full text-sm font-semibold text-slate-600" onClick={() => go("overview")}>{tr("Back to route", "الرجوع للجولة")}</button>
            </div>
          </>
        ) : null}

        {screen === "leftovers" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-bold uppercase text-slate-500">{tr("Route end", "نهاية الجولة")}</p>
            <h3 className="mt-1 text-xl font-bold">{tr("Operator bag leftovers", "البواقي في شنطة المشغل")}</h3>
            <p className="mt-1 text-sm text-slate-600">{tr("Pickup minus completed-stop fills. Returning items to storage is a separate real ledger operation; this is just a demonstration.", "الكمية المستلمة ناقص التعبئة في المواقع المكتملة. إرجاع المخزون الحقيقي عملية مستقلة؛ هذه محاكاة فقط.")}</p>
            <div className="mt-3 space-y-2">
              {PRODUCTS.filter((p) => (state.pickup[p.id] ?? 0) > 0).map((product) => (
                <div key={product.id} className="flex justify-between rounded-xl border border-slate-200 p-3 text-sm">
                  <span className="font-bold">{product[ar ? "ar" : "en"]}</span>
                  <span>{tr("Remaining", "الباقي")}: <strong>{(state.pickup[product.id] ?? 0) - (used[product.id] ?? 0)}</strong></span>
                </div>
              ))}
            </div>
            {completed < 3 ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{tr("Complete all three training stops before ending the route.", "أكمل المواقع التدريبية الثلاثة قبل إنهاء الجولة.")}</p> : null}
            <button type="button" disabled={completed < 3 || state.routeCompleted} className="btn-primary mt-4 w-full disabled:opacity-40"
              onClick={() => { setState((prev) => ({ ...prev, routeCompleted: true })); go("overview"); }}>
              {tr("Complete Route (training)", "إنهاء الجولة (تدريب)")}
            </button>
          </section>
        ) : null}
      </div>
    </section>
  );
}
