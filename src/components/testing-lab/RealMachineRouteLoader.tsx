"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrainingRouteClient } from "@/components/testing-lab/TrainingRouteClient";
import { PhotoLibraryAiTest } from "@/components/testing-lab/PhotoLibraryAiTest";
import { useLanguage } from "@/components/I18nProvider";
import { buildRealMachineTrainingFixture, type QaReadOnlySnapshot } from "@/lib/qa-real-machine-fixture";

export function RealMachineRouteLoader() {
  const { locale } = useLanguage();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const [state, setState] = useState<
    { state: "loading" } | { state: "error"; error: string } |
    { state: "ready"; data: ReturnType<typeof buildRealMachineTrainingFixture> }
  >({ state: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/qa-real-route-snapshot", { cache: "no-store" });
        const body = await res.json().catch(() => null) as QaReadOnlySnapshot | null;
        if (!res.ok || !body?.ok || !body.machines?.length) {
          throw new Error(body?.error || "Could not load real machine and product data.");
        }
        if (alive) setState({ state: "ready", data: buildRealMachineTrainingFixture(body) });
      } catch (cause) {
        if (alive) setState({
          state: "error", error: cause instanceof Error ? cause.message : "Could not load QA route.",
        });
      }
    };
    void load();
    return () => { alive = false; };
  }, [generation]);

  if (state.state === "loading") return (
    <div role="status" className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-700">
      {tr("Loading actual machine selections and products from XY inventory snapshot…", "جارٍ تحميل خانات ومنتجات الماكينات الحقيقية من لقطة مخزون XY…")}
    </div>
  );
  if (state.state === "error") return (
    <div role="alert" className="mx-auto max-w-5xl space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-900">
      <strong>{state.error}</strong>
      <button type="button" className="btn-secondary block" onClick={() => { setState({ state: "loading" }); setGeneration((v) => v + 1); }}>
        {tr("Retry snapshot", "أعد تحميل البيانات")}
      </button>
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-3 py-6">
      <nav className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/operator/routes" className="btn-secondary">{tr("← My Routes", "← جولاتي")}</Link>
        <span className="rounded-full bg-amber-100 px-4 py-2 text-xs font-extrabold text-amber-950">
          {tr("TEST COPY · NO PRODUCTION WRITES", "نسخة تجربة · بدون تعديلات حقيقية")}
        </span>
      </nav>
      {state.data.omitted.length > 0 ? (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <strong>
            {tr("Unverified XY selections were excluded from training — not treated as zero stock.",
              "تم استبعاد خانات XY غير المؤكدة من التدريب، ولم تُحتسب كمخزون صفر.")}
          </strong>
          <p className="mt-1">
            {tr("Only selections with known quantity, capacity and selling price appear in this simulation. Review missing values in XY before planning a real refill.",
              "التجربة تعرض فقط الخانات ذات الكمية والسعة والسعر المؤكد. راجع البيانات الناقصة في XY قبل تخطيط تعبئة حقيقية.")}
          </p>
          <p className="mt-2 font-semibold">
            {tr("Excluded selections", "الخانات المستبعدة")}: {state.data.omitted.length}
          </p>
          <p className="mt-1 break-words" dir="ltr">
            {state.data.omitted.slice(0, 12).map(item => `${item.machineCode} / ${item.slotCode} (${item.reason})`).join(" · ")}
            {state.data.omitted.length > 12 ? " …" : ""}
          </p>
          <Link href="/admin/vms-api" className="mt-2 inline-block font-semibold underline underline-offset-2">
            {tr("Review XY data", "مراجعة بيانات XY")}
          </Link>
        </div>
      ) : null}
      <TrainingRouteClient key={generation} realData={state.data} />
      <PhotoLibraryAiTest />
    </div>
  );
}
