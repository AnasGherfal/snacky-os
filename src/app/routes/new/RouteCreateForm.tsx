"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, FormSection, SecondaryButton } from "@/components/ui";

type Operator = {
  id: string;
  full_name: string;
};

type Machine = {
  id: string;
  name: string;
  machine_code: string;
};

type Recommendation = {
  machine_slot_id: string;
  machine_id: string;
  machine_name: string;
  machine_code: string;
  slot_code: string;
  product_id: string;
  product_name: string;
  current_qty: number;
  par_qty: number;
  suggested_qty: number;
  available_storage_qty: number;
  final_qty_to_take: number;
};

type StorageInventory = {
  product_id: string;
  product_name: string;
  quantity_on_hand: number;
};

export function RouteCreateForm({
  operators,
  machines,
  recommendations,
  storageInventory,
  defaultRouteDate,
}: {
  operators: Operator[];
  machines: Machine[];
  recommendations: Recommendation[];
  storageInventory: StorageInventory[];
  defaultRouteDate: string;
}) {
  const router = useRouter();
  const [routeDate, setRouteDate] = useState(defaultRouteDate);
  const [operatorId, setOperatorId] = useState("");
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [machineSlotIds, setMachineSlotIds] = useState<string[]>([]);
  const [routeStock, setRouteStock] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedStopCount = useMemo(() => {
    const recommendedMachines = recommendations
      .filter((row) => machineSlotIds.includes(row.machine_slot_id))
      .map((row) => row.machine_id);
    return new Set([...machineIds, ...recommendedMachines]).size;
  }, [machineIds, machineSlotIds, recommendations]);

  const toggleValue = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

  const plannedRouteStock = useMemo(() => {
    const planned = new Map<string, { productId: string; quantity: number; available: number }>();

    recommendations
      .filter((row) => machineSlotIds.includes(row.machine_slot_id))
      .forEach((row) => {
        const quantity = Number(row.final_qty_to_take ?? row.suggested_qty ?? 0);
        const current = planned.get(row.product_id);
        planned.set(row.product_id, {
          productId: row.product_id,
          quantity: (current?.quantity ?? 0) + quantity,
          available: Number(row.available_storage_qty ?? 0),
        });
      });

    Object.entries(routeStock).forEach(([productId, quantity]) => {
      const item = storageInventory.find((row) => row.product_id === productId);
      const current = planned.get(productId);
      planned.set(productId, {
        productId,
        quantity: (current?.quantity ?? 0) + Math.max(0, Number(quantity)),
        available: Number(item?.quantity_on_hand ?? current?.available ?? 0),
      });
    });

    return Array.from(planned.values()).filter((item) => item.quantity > 0);
  }, [machineSlotIds, recommendations, routeStock, storageInventory]);

  const validate = () => {
    if (!routeDate) return "Route date is required.";
    if (!operatorId) return "Operator is required when creating an assigned route.";
    if (!machineIds.length && !machineSlotIds.length) return "Select at least one machine stop or refill recommendation.";
    if (!plannedRouteStock.length) return "Choose products to take from storage for this route.";
    const overPicked = plannedRouteStock.find((item) => item.quantity > item.available);
    if (overPicked) return "One or more selected products exceeds available storage stock.";
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeDate, operatorId, machineIds, machineSlotIds, routeStock: plannedRouteStock }),
      });
      const result = await response.json();

      if (!response.ok || !result.routeId) {
        throw new Error(result.error || "Could not create the route.");
      }

      window.sessionStorage.setItem("snacky-route-created", "Route created successfully.");
      router.push(`/routes/${result.routeId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the route.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {error}
        </div>
      ) : null}

      <FormSection title="Route overview">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Route date" required>
            <input type="date" value={routeDate} onChange={(event) => setRouteDate(event.target.value)} className="field-input" required disabled={saving} />
          </FormField>
          <FormField label="Operator" required>
            <select value={operatorId} onChange={(event) => setOperatorId(event.target.value)} className="field-input" required disabled={saving}>
              <option value="">Select operator</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.full_name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Refill recommendation rows">
        <p className="text-sm text-slate-500">Select recommended refill lines to create route stops and supply pick details automatically.</p>
        {!recommendations.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No active refill recommendations found. Import VMS stock and add machine slots to fill this list.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2">Machine</th>
                  <th className="px-3 py-2">Slot</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Current</th>
                  <th className="px-3 py-2">Par</th>
                  <th className="px-3 py-2">Take</th>
                  <th className="px-3 py-2">Storage</th>
                </tr>
              </thead>
              <tbody>
                {recommendations.map((row) => (
                  <tr key={row.machine_slot_id} className="border-t border-slate-200">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={machineSlotIds.includes(row.machine_slot_id)}
                        onChange={() => setMachineSlotIds((current) => toggleValue(current, row.machine_slot_id))}
                        className="h-4 w-4"
                        disabled={saving}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{row.machine_name}</td>
                    <td className="px-3 py-2">{row.slot_code}</td>
                    <td className="px-3 py-2">{row.product_name}</td>
                    <td className="px-3 py-2">{row.current_qty}</td>
                    <td className="px-3 py-2">{row.par_qty}</td>
                    <td className="px-3 py-2 font-semibold">{row.final_qty_to_take ?? row.suggested_qty}</td>
                    <td className="px-3 py-2">{row.available_storage_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormSection>

      <FormSection title="Route stock from storage">
        <p className="text-sm text-slate-500">Confirm the products that will leave storage for this route. Recommendations are included automatically; add extra route stock only when needed.</p>
        {!storageInventory.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No positive storage stock found. Receive inventory movements into storage before creating a stock-carrying route.
          </div>
        ) : (
          <div className="grid gap-3">
            {storageInventory.map((item) => {
              const recommendedQty = recommendations
                .filter((row) => machineSlotIds.includes(row.machine_slot_id) && row.product_id === item.product_id)
                .reduce((sum, row) => sum + Number(row.final_qty_to_take ?? row.suggested_qty ?? 0), 0);
              const extraQty = routeStock[item.product_id] ?? 0;
              const totalQty = recommendedQty + extraQty;
              const exceedsStock = totalQty > Number(item.quantity_on_hand);

              return (
                <div key={item.product_id} className={`rounded-xl border bg-white p-4 ${exceedsStock ? "border-rose-300" : "border-slate-200"}`}>
                  <div className="grid gap-3 md:grid-cols-[1fr_120px_120px_120px] md:items-end">
                    <div>
                      <div className="font-medium text-slate-900">{item.product_name}</div>
                      <div className="text-xs text-slate-500">Available in storage: {item.quantity_on_hand}</div>
                    </div>
                    <div className="text-sm">
                      <div className="text-xs text-slate-500">Recommended</div>
                      <div className="font-semibold">{recommendedQty}</div>
                    </div>
                    <FormField label="Extra">
                      <input
                        type="number"
                        min="0"
                        max={Math.max(0, Number(item.quantity_on_hand) - recommendedQty)}
                        value={extraQty}
                        onChange={(event) => setRouteStock((current) => ({ ...current, [item.product_id]: Math.max(0, Number(event.target.value) || 0) }))}
                        className="field-input"
                        disabled={saving}
                      />
                    </FormField>
                    <div className="text-sm">
                      <div className="text-xs text-slate-500">Route total</div>
                      <div className={exceedsStock ? "font-semibold text-rose-700" : "font-semibold text-slate-900"}>{totalQty}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </FormSection>

      <FormSection title="Add machine stops manually">
        <p className="text-sm text-slate-500">Choose machines that should be included in the route even if there is no recommendation row.</p>
        {!machines.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No active machines found. Create a machine first.
          </div>
        ) : (
          <div className="grid gap-2">
            {machines.map((machine) => (
              <label key={machine.id} className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:border-slate-400">
                <input
                  type="checkbox"
                  checked={machineIds.includes(machine.id)}
                  onChange={() => setMachineIds((current) => toggleValue(current, machine.id))}
                  className="h-4 w-4"
                  disabled={saving}
                />
                <span>
                  {machine.name} <span className="text-slate-500">({machine.machine_code})</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </FormSection>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Selected stops: <span className="font-semibold text-slate-900">{selectedStopCount}</span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" className="btn-primary disabled:cursor-not-allowed disabled:opacity-60" disabled={saving}>
          {saving ? "Creating route..." : "Create route"}
        </button>
        <SecondaryButton href="/routes">Cancel</SecondaryButton>
      </div>
    </form>
  );
}
