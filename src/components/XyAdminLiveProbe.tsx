"use client";

import { useState } from "react";

type Machine = { id: string; name: string; machineCode: string | null };
type Selection = {
  slotCode: string; vmsProductId: string | null; productName: string | null;
  priceLyd: number | null; currentQty: number | null; capacity: number | null;
  issues: string[];
};
type Probe = {
  ok: boolean; error?: string; fetchedAt?: string; responseMs?: number;
  machine?: Machine; totalSelections?: number; problematicSelections?: number;
  selections?: Selection[];
};

export function XyAdminLiveProbe({ machines }: { machines: Machine[] }) {
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Probe | null>(null);

  async function readLive() {
    if (!machineId || loading) return;
    setLoading(true);
    setData(null);
    try {
      const result = await fetch(`/api/admin/xy-live-layout?machineId=${encodeURIComponent(machineId)}`, {
        method: "GET", cache: "no-store", credentials: "same-origin",
      });
      const payload = await result.json() as Probe;
      setData(payload);
    } catch {
      setData({ ok: false, error: "Could not reach the Snacky XY live-read service." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="surface-card mb-6">
      <h2 className="text-base font-semibold text-slate-900">Direct XY Live Read</h2>
      <p className="mt-1 text-sm text-slate-500">
        Read actual product, price and stock directly from the XY vendor now. This is read-only
        and never changes the vending machine. Historical imports are not labelled live.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="xy-direct-probe-machine" className="text-sm font-medium">Machine</label>
        <select
          id="xy-direct-probe-machine"
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          value={machineId}
          onChange={(event) => { setMachineId(event.target.value); setData(null); }}
        >
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>{machine.name} · {machine.machineCode ?? "No code"}</option>
          ))}
        </select>
        <button type="button" className="btn-primary" disabled={!machineId || loading} onClick={readLive}>
          {loading ? "Reading XY..." : "Check Live XY"}
        </button>
      </div>
      {data && !data.ok ? (
        <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          {data.error ?? "XY live read failed."}
        </div>
      ) : null}
      {data?.ok ? (
        <div className="mt-4">
          <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <strong>Verified direct XY read</strong> · {data.totalSelections ?? 0} selections
            · {data.problematicSelections ?? 0} needs review
            · {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "-"}
            · {data.responseMs ?? "-"} ms
          </p>
          <div className="mt-3 max-h-[26rem] overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[650px] text-left text-sm">
              <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-600">
                <tr><th className="p-3">Selection</th><th className="p-3">Product (XY)</th>
                  <th className="p-3">Price (LYD)</th><th className="p-3">Qty / Capacity</th><th className="p-3">Status</th></tr>
              </thead>
              <tbody>
                {(data.selections ?? []).map((slot) => (
                  <tr key={slot.slotCode} className={slot.issues.length ? "border-t border-amber-200 bg-amber-50" : "border-t border-slate-100"}>
                    <td className="p-3 font-medium">{slot.slotCode}</td>
                    <td className="p-3">{slot.productName ?? "Unassigned"} <span className="text-xs text-slate-500">{slot.vmsProductId ?? ""}</span></td>
                    <td className="p-3">{slot.priceLyd ?? "-"}</td>
                    <td className="p-3">{slot.currentQty ?? "Unknown"} / {slot.capacity ?? "Unknown"}</td>
                    <td className="p-3">{slot.issues.length ? slot.issues.join("; ") : "OK"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
