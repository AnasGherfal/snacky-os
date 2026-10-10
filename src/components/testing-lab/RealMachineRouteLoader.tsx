"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrainingRouteClient, type TrainingProduct, type TrainingStop, type TrainingLane } from "@/components/testing-lab/TrainingRouteClient";
import { PhotoLibraryAiTest } from "@/components/testing-lab/PhotoLibraryAiTest";
import { useLanguage } from "@/components/I18nProvider";

type MachineSnapshot = {
  id: string; name: string; machineCode: string;
  slots: Array<{
    slotCode: string; productId: string | null; productName: string;
    currentQty: number | null; capacity: number | null; priceLyd: number; capturedAt: string | null;
  }>;
};
type ReadOnlySnapshot = {
  ok: boolean; error?: string; capturedAt: string | null;
  machines: MachineSnapshot[];
};

function buildFixture(snapshot: ReadOnlySnapshot) {
  const byProduct = new Map<string, TrainingProduct>();
  const stops: TrainingStop[] = snapshot.machines.map((machine) => {
    let planned = 0;
    const lanes: TrainingLane[] = machine.slots.map((slot) => {
      // Distinguish exact physical selection from product total.
      // A product without an identified SKU is represented only for display.
      const productId = slot.productId ?? `unmapped:${machine.id}:${slot.slotCode}`;
      if (!byProduct.has(productId)) {
        byProduct.set(productId, { id: productId, en: slot.productName, ar: slot.productName });
      }
      const capacity = Math.max(1, Math.min(100, Number(slot.capacity ?? 10) || 10));
      const starting = Math.max(0, Math.min(capacity, Number(slot.currentQty ?? 0) || 0));
      // Restrict the training pickup to just a few actual low-stock selections.
      // Every real machine selection is displayed, but we don't invent huge pickups.
      const needed = Math.max(0, Math.min(6, capacity - starting));
      const plannedAdd = planned < 6 && slot.productId && needed >= 2 && starting < Math.floor(capacity * 0.75)
        ? needed : 0;
      if (plannedAdd > 0) planned++;
      return {
        code: slot.slotCode,
        productId, originalProductId: productId,
        initialQty: starting, plannedAdd, actualAdd: 0,
        capacity, xyQty: starting, xyProductId: productId,
        priceLyd: Math.max(0.01, Number(slot.priceLyd) || 1),
        oldStockHandled: false,
      };
    });
    return {
      id: machine.id, name: machine.name, location: "Tripoli",
      machineCode: machine.machineCode, status: "assigned" as const,
      xyPending: false, pendingReason: "", cleaningDone: false, photoReady: false,
      note: "", verifiedAt: null, issues: [], lanes,
    };
  });
  return { stops, products: Array.from(byProduct.values()), capturedAt: snapshot.capturedAt };
}

export function RealMachineRouteLoader() {
  const { locale } = useLanguage();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const [state, setState] = useState<
    { state: "loading" } | { state: "error"; error: string } |
    { state: "ready"; data: ReturnType<typeof buildFixture> }
  >({ state: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/qa-real-route-snapshot", { cache: "no-store" });
        const body = await res.json().catch(() => null) as ReadOnlySnapshot | null;
        if (!res.ok || !body?.ok || !body.machines?.length) {
          throw new Error(body?.error || "Could not load real machine and product data.");
        }
        if (alive) setState({ state: "ready", data: buildFixture(body) });
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
      <TrainingRouteClient key={generation} realData={state.data} />
      <PhotoLibraryAiTest />
    </div>
  );
}
