"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { QuantityStepper } from "@/components/QuantityStepper";

interface StopSummary {
  stopId: string;
  routeId: string;
  machineId: string;
  stopOrder: number;
  stopStatus: string;
  routeStatus: string | null;
  routeDate: string | null;
  operatorId: string | null;
  machineName: string;
  machineCode: string | null;
}

interface RefillItem {
  refillOrderLineId?: string | null;
  productId: string;
  productName: string;
  assignedQty?: number;
  parQty?: number;
  filledQty?: number | null;
}

interface StopDetails {
  stopId: string;
  routeId: string;
  machineId: string;
  machineName: string;
  location?: string;
  stopStatus: string;
  routeStatus: string;
  refillItems: RefillItem[];
}

function shortId(value: string) {
  return value ? `${value.slice(0, 8)}…` : "—";
}

export default function AdminStopOverridePage() {
  const [stops, setStops] = useState<StopSummary[]>([]);
  const [selected, setSelected] = useState<StopSummary | null>(null);
  const [details, setDetails] = useState<StopDetails | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");

  const loadStops = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/stop-override", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || "Could not load unfinished stops.");
      setStops(Array.isArray(payload.stops) ? payload.stops : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load unfinished stops.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStops(); }, [loadStops]);

  const filteredStops = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return stops;
    return stops.filter((stop) => [stop.machineName, stop.machineCode, stop.routeId, stop.stopId, stop.stopStatus]
      .some((value) => String(value ?? "").toLowerCase().includes(needle)));
  }, [search, stops]);

  async function openStop(stop: StopSummary) {
    setSelected(stop);
    setDetails(null);
    setQuantities({});
    setNotice("");
    setError("");
    setDetailsLoading(true);
    try {
      const response = await fetch(`/api/operator/routes/${stop.routeId}/stops/${stop.stopId}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Could not load stop products.");
      setDetails(payload);
      const initial: Record<string, number> = {};
      (payload.refillItems ?? []).forEach((item: RefillItem) => {
        const suggested = item.filledQty ?? item.assignedQty ?? item.parQty ?? 0;
        initial[item.productId] = Math.max(0, Math.floor(Number(suggested) || 0));
      });
      setQuantities(initial);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load stop products.");
    } finally {
      setDetailsLoading(false);
    }
  }

  async function finishStop() {
    if (!selected || !details) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const filledItems = details.refillItems.map((item) => ({
        refillOrderLineId: item.refillOrderLineId ?? null,
        productId: item.productId,
        quantity: quantities[item.productId] ?? 0,
        assignedQty: Number(item.assignedQty ?? item.parQty ?? 0),
      }));
      const response = await fetch("/api/admin/stop-override", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          routeId: selected.routeId,
          stopId: selected.stopId,
          filledItems,
          notes: "Admin/owner override: operator app/workflow issue; quantities entered manually and stop completed without proof photos.",
        }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || "Could not finish the stop.");
      setNotice("Stop finished with admin override. No proof photos were required.");
      setSelected(null);
      setDetails(null);
      setQuantities({});
      await loadStops();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish the stop.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-950">Admin stop override</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Owner/admin recovery tool for cases where the operator app failed or the operator could not finish the stop. Enter the actual product quantities and complete the stop without uploading random proof photos.
        </p>
      </header>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        This bypass is only for owner/admin recovery. Normal operator stop completion still requires the normal machine, compressor and XY evidence.
      </div>

      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{notice}</div> : null}

      {!selected ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-950">Unfinished stops</h2>
              <p className="text-sm text-slate-500">Choose the stop you need to recover.</p>
            </div>
            <button type="button" onClick={() => void loadStops()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Refresh</button>
          </div>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search machine, route, status…"
            className="mt-4 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
          />
          {loading ? <p className="mt-4 text-sm text-slate-500">Loading unfinished stops…</p> : null}
          {!loading && !filteredStops.length ? <p className="mt-4 text-sm text-slate-500">No unfinished stops found.</p> : null}
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {filteredStops.map((stop) => (
              <button
                key={stop.stopId}
                type="button"
                onClick={() => void openStop(stop)}
                className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-slate-400 hover:bg-slate-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-bold text-slate-950">{stop.machineName}</div>
                    <div className="mt-1 text-xs text-slate-500">{stop.machineCode ? `${stop.machineCode} · ` : ""}Stop #{stop.stopOrder}</div>
                  </div>
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">{stop.stopStatus}</span>
                </div>
                <div className="mt-3 text-xs text-slate-500">Route {shortId(stop.routeId)} · {stop.routeStatus ?? "—"}</div>
                {stop.operatorId ? <div className="mt-1 text-xs text-slate-500">Assigned operator {shortId(stop.operatorId)}</div> : null}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-950">{selected.machineName}</h2>
              <p className="mt-1 text-sm text-slate-500">Enter what was actually put into the machine.</p>
            </div>
            <button type="button" disabled={submitting} onClick={() => { setSelected(null); setDetails(null); setError(""); }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Back</button>
          </div>

          {detailsLoading ? <p className="mt-5 text-sm text-slate-500">Loading products…</p> : null}
          {details ? (
            <div className="mt-5 space-y-3">
              {details.refillItems.map((item) => (
                <div key={item.productId} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-950">{item.productName}</div>
                    <div className="mt-1 text-xs text-slate-500">Planned/taken: {Number(item.assignedQty ?? item.parQty ?? 0)}</div>
                  </div>
                  <div className="w-40 max-w-[45%]">
                    <QuantityStepper
                      value={quantities[item.productId] ?? 0}
                      min={0}
                      disabled={submitting}
                      inputLabel={item.productName}
                      onChange={(value) => setQuantities((current) => ({ ...current, [item.productId]: value }))}
                    />
                  </div>
                </div>
              ))}
              {!details.refillItems.length ? <p className="text-sm text-slate-500">No refill products are attached to this stop.</p> : null}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                This action records an owner/admin override instead of a fake photo. Inventory movements and stop completion still use the quantities above.
              </div>

              <button
                type="button"
                disabled={submitting || detailsLoading}
                onClick={() => void finishStop()}
                className="min-h-12 w-full rounded-xl bg-emerald-600 px-5 py-3 text-base font-bold text-white disabled:bg-slate-300"
              >
                {submitting ? "Finishing stop…" : "Finish stop without photos"}
              </button>
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
