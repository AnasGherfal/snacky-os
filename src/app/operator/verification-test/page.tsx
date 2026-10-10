"use client";

import { useEffect, useMemo, useState } from "react";
import { GuidedMachineCamera } from "@/components/operator/GuidedMachineCamera";
import Link from "next/link";
import { useLanguage } from "@/components/I18nProvider";
import { verifyMachineQuantityRowsAgainstXy } from "@/lib/xy-quantity-verification";
import type { MachineQuantityRow } from "@/lib/machine-quantity-confirmation";

type TestSelection = {
  code: string;
  productId: string;
  productName: string;
  planned: number;
  physicallyFilled: number;
  xyQty: number;
  xyProductId: string;
};
type TestStop = { name: string; selections: TestSelection[] };
type Check = { checkedAt: string; verified: boolean; mismatches: Array<{
  slotCode: string; expectedQty: number; actualQty: number | null; reason: string;
}> };
const originals: TestStop[] = [
  { name: "TEST · University", selections: [
    { code: "001", productId: "cola", productName: "Cola", planned: 8, physicallyFilled: 8, xyQty: 8, xyProductId: "cola" },
    { code: "003", productId: "cola", productName: "Cola", planned: 8, physicallyFilled: 8, xyQty: 0, xyProductId: "cola" },
    { code: "005", productId: "water", productName: "Water", planned: 6, physicallyFilled: 6, xyQty: 6, xyProductId: "water" },
  ] },
  { name: "TEST · Hospital", selections: [
    { code: "011", productId: "juice", productName: "Juice", planned: 6, physicallyFilled: 4, xyQty: 4, xyProductId: "juice" },
    { code: "012", productId: "snack", productName: "Snack", planned: 5, physicallyFilled: 0, xyQty: 0, xyProductId: "snack" },
  ] },
  { name: "TEST · Mall", selections: [
    { code: "021", productId: "water", productName: "Water", planned: 10, physicallyFilled: 10, xyQty: 10, xyProductId: "cola" },
    { code: "022", productId: "snack", productName: "Snack", planned: 5, physicallyFilled: 5, xyQty: 5, xyProductId: "snack" },
  ] },
];

function makeCheck(stop: TestStop): Check {
  const rows: MachineQuantityRow[] = stop.selections.filter((selection) => selection.physicallyFilled > 0)
    .map((selection) => ({
      productId: selection.productId,
      productName: selection.productName,
      machineSlotId: selection.code,
      slotCode: selection.code,
      previousQty: 0,
      addedQty: selection.physicallyFilled,
      finalQty: selection.physicallyFilled,
    }));
  const layout = stop.selections.map((selection) => ({
    slotCode: selection.code,
    vmsProductId: selection.xyProductId,
    productName: selection.xyProductId,
    currentQty: selection.xyQty,
    capacity: 20,
    priceLyd: 5,
  }));
  const products = new Map(stop.selections.flatMap((selection) =>
    [[selection.productId, selection.productId], [selection.xyProductId, selection.xyProductId]] as Array<[string, string]>));
  const result = verifyMachineQuantityRowsAgainstXy(rows, layout, products);
  return { checkedAt: new Date().toISOString(), ...result };
}

/** Safe, in-browser test route. NEVER calls production XY, inventory or Finance APIs. */
export default function VerificationTestRoute() {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [stops, setStops] = useState<TestStop[]>(() => structuredClone(originals));
  const [index, setIndex] = useState(0);
  const [checks, setChecks] = useState<Record<number, Check>>({});
  const [finished, setFinished] = useState(false);
  const [testPhotoUrl, setTestPhotoUrl] = useState<string | null>(null);
  useEffect(() => () => { if (testPhotoUrl) URL.revokeObjectURL(testPhotoUrl); }, [testPhotoUrl]);
  const stop = stops[index];
  const check = checks[index];
  const missing = useMemo(() => stop.selections.filter((s) => s.physicallyFilled < s.planned), [stop]);
  const update = (slotCode: string, field: "physicallyFilled" | "xyQty" | "xyProductId", value: number | string) => {
    setStops((previous) => previous.map((entry, stopIndex) => stopIndex !== index ? entry : {
      ...entry,
      selections: entry.selections.map((s) => s.code === slotCode ? { ...s, [field]: value } : s),
    }));
    setChecks((previous) => { const next = { ...previous }; delete next[index]; return next; });
    setFinished(false);
  };
  const reset = () => { setStops(structuredClone(originals)); setChecks({}); setIndex(0); setFinished(false); setTestPhotoUrl(null); };

  return <main dir={ar ? "rtl" : "ltr"} className="mx-auto max-w-5xl space-y-5 px-3 py-6 sm:px-6">
    <div className="rounded-3xl bg-emerald-950 p-5 text-white sm:p-7">
      <div className="text-xs font-extrabold uppercase tracking-widest text-amber-300">SNACKY OS · QA</div>
      <h1 className="mt-2 text-2xl font-bold sm:text-3xl">{tr("Refill Verification — Test Route", "جولة تجريبية — التحقق من التعبئة")}</h1>
      <p className="mt-2 max-w-2xl text-sm text-emerald-100">{tr(
        "Safe simulation: three machine stops, real selection-level comparison logic, no production data changes and no XY commands. Test before rolling out to operators.",
        "محاكاة آمنة: ثلاثة مواقع وقراءة تحقق لكل خانة، دون تغيير المخزون الحقيقي أو إرسال أوامر إلى XY. جرّبها قبل اعتمادها للمشغلين.",
      )}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/operator" className="rounded-lg border border-emerald-500 px-3 py-2 text-sm font-semibold">{tr("Back to operator", "العودة للمشغل")}</Link>
        <button type="button" onClick={reset} className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-emerald-950">{tr("Reset test route", "إعادة الجولة التجريبية")}</button>
      </div>
    </div>

    <nav aria-label="Test stops" className="grid grid-cols-3 gap-2">
      {stops.map((entry, stopIndex) => <button type="button" key={entry.name} onClick={() => {setIndex(stopIndex);setFinished(false);}}
        className={`rounded-xl border p-3 text-start text-xs font-semibold sm:text-sm ${index === stopIndex ? "border-emerald-600 bg-emerald-50 text-emerald-950" : "border-slate-200 bg-white text-slate-700"}`}>
        <span className="block text-xs text-slate-500">{tr("Stop", "الموقع")} {stopIndex + 1}</span>
        {entry.name}<span className="mt-1 block text-xs">{checks[stopIndex]?.verified ? "✓ " + tr("Checked", "تم التحقق") : checks[stopIndex] ? "! " + tr("Fix issues", "تحتاج تصحيح") : tr("Not checked", "لم يتم التحقق")}</span>
      </button>)}
    </nav>

    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-slate-900">{stop.name}</h2>
          <p className="mt-1 text-sm text-slate-500">{tr("Record what was physically filled, then compare against simulated XY after refreshing.", "سجّل ما تم وضعه فعلاً في الجهاز، ثم قارنه بكميات XY الافتراضية بعد التحديث.")}</p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">{tr("TEST ONLY", "للاختبار فقط")}</span>
      </div>
      <div className="mt-5 grid gap-3">
        {stop.selections.map((selection) => <div key={selection.code} className="grid grid-cols-2 items-center gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-5">
          <div className="col-span-2 sm:col-span-1"><strong className="text-base text-slate-900">{selection.code}</strong>
            <div className="text-sm text-slate-600">{selection.productName}</div><div className="text-xs text-slate-500">{tr("Planned", "المخطط")}: {selection.planned}</div>
          </div>
          <label className="text-xs font-semibold text-slate-600">{tr("Actually filled", "تمت تعبئته")}
            <input type="number" min="0" max="20" step="1" className="field-input mt-1 w-full"
              value={selection.physicallyFilled} onChange={(e) => update(selection.code, "physicallyFilled", Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
          </label>
          <label className="text-xs font-semibold text-slate-600">{tr("XY stock (simulation)", "مخزون XY الافتراضي")}
            <input type="number" min="0" max="20" step="1" className="field-input mt-1 w-full"
              value={selection.xyQty} onChange={(e) => update(selection.code, "xyQty", Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-600 sm:col-span-1">{tr("XY product", "منتج XY")}
            <select className="field-input mt-1 w-full" value={selection.xyProductId}
              onChange={(e) => update(selection.code, "xyProductId", e.target.value)}>
              {["cola", "water", "juice", "snack"].map((product) => <option key={product} value={product}>{product}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => update(selection.code, "xyQty", selection.physicallyFilled)}
            className="col-span-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 sm:col-span-5">
            {tr("Simulate updating this XY selection", "محاكاة تحديث كمية هذه الخانة في XY")}
          </button>
        </div>)}
      </div>
      {missing.length ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        {tr("Partial/missing pickup:", "تعبئة ناقصة أو منتج لم يُجلب:")} {missing.map((s) => `${s.code} (${s.physicallyFilled}/${s.planned})`).join(" · ")}. {tr("These must be recorded as exceptions in the real refill form.", "تُسجل هذه الحالات كنواقص في نموذج التعبئة الحقيقي.")}
      </p> : null}
      <button type="button" onClick={() => setChecks((previous) => ({ ...previous, [index]: makeCheck(stop) }))}
        className="btn-primary mt-5 w-full">{tr("↻ Refresh & verify XY (test)", "↻ تحديث القراءة والتحقق من XY (تجريبي)")}</button>
      {check ? <div role="status" className={`mt-4 rounded-xl border p-4 ${check.verified ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
        <strong className={check.verified ? "text-emerald-900" : "text-rose-900"}>{check.verified ? tr("All filled selections match XY.", "كل الخانات المعبأة مطابقة لـ XY.") : tr(`${check.mismatches.length} selections need correction`, `${check.mismatches.length} خانات تحتاج تصحيحاً`)}</strong>
        <p className="mt-1 text-xs text-slate-600">{tr("Checked at", "وقت التحقق")}: {new Date(check.checkedAt).toLocaleTimeString(ar ? "ar-LY" : "en-US")}</p>
        {check.mismatches.map((mismatch, i) => <p key={i} className="mt-2 rounded-lg bg-white p-2 text-sm text-rose-900">
          {mismatch.slotCode} · {tr("Expected", "المتوقع")} {mismatch.expectedQty} / XY {mismatch.actualQty ?? "—"} · {mismatch.reason}
        </p>)}
      </div> : null}
    </section>

    <section className="rounded-2xl border-2 border-amber-200 bg-white p-4 sm:p-6">
      <div className="text-xs font-bold tracking-widest text-amber-700">SNACKY OS · CAMERA QA</div>
      <h2 className="mt-1 text-lg font-bold text-slate-950">{tr("Try the guided camera without saving anything", "جرّب كاميرا الإطار دون حفظ أي شيء في النظام")}</h2>
      <p className="my-3 text-sm leading-6 text-slate-600">{tr("Test the green frame, standard/wide machine options, lighting warnings, and retake on your phone. The photo stays only in this browser tab; it is NOT uploaded to Snacky or used to change XY.", "جرّب الإطار الأخضر وخيارات الماكينة العادية والعريضة وتنبيهات الإضاءة وإعادة التصوير على هاتفك. تبقى الصورة في صفحة المتصفح فقط، ولا تُرفع إلى سناكي ولا تغيّر XY.")}</p>
      <GuidedMachineCamera disabled={false} onCaptured={async (file) => { setTestPhotoUrl(URL.createObjectURL(file)); return true; }} />
      {testPhotoUrl ? (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-xs font-semibold text-emerald-900">{tr("Local camera preview — not saved to any server", "معاينة تجريبية محلية — لم تُحفظ في أي خادم")}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={testPhotoUrl} alt={tr("Local guided camera test", "تجربة إطار تصوير الماكينة")} className="mt-2 max-h-72 w-full rounded-lg object-contain" />
        </div>
      ) : null}
    </section>

    <div className="flex flex-wrap gap-3">
      <button type="button" onClick={() => {setIndex((i) => Math.min(stops.length - 1, i + 1));setFinished(false);}}
        disabled={index === stops.length - 1} className="btn-secondary flex-1 disabled:opacity-40">{tr("Next test stop", "الموقع التجريبي التالي")}</button>
      <button type="button" onClick={() => setFinished(true)} className="btn-primary flex-1">{tr("Test route summary", "ملخص الجولة التجريبية")}</button>
    </div>
    {finished ? <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="font-bold">{tr("Verification test summary", "ملخص اختبار التحقق")}</h2>
      {stops.map((entry, i) => <p key={entry.name} className="mt-2 text-sm">
        {entry.name}: {checks[i]?.verified ? tr("Verified", "تم التحقق") : checks[i] ? tr("Unresolved mismatch", "اختلاف لم يُحل") : tr("Not tested", "لم يُختبر")}
      </p>)}
      <p className="mt-3 text-xs text-slate-500">{tr("This test did not create a real route or post inventory, cash or vendor updates.", "هذا الاختبار لم ينشئ جولة حقيقية ولم يسجّل حركات مخزون أو نقد أو أوامر للمورّد.")}</p>
    </section> : null}
  </main>;
}
