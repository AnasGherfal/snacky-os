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
  product_name: string;
  current_qty: number;
  par_qty: number;
  suggested_qty: number;
};

export function RouteCreateForm({
  operators,
  machines,
  recommendations,
  defaultRouteDate,
}: {
  operators: Operator[];
  machines: Machine[];
  recommendations: Recommendation[];
  defaultRouteDate: string;
}) {
  const router = useRouter();
  const [routeDate, setRouteDate] = useState(defaultRouteDate);
  const [operatorId, setOperatorId] = useState("");
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [machineSlotIds, setMachineSlotIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedStopCount = useMemo(() => {
    const recommendedMachines = recommendations
      .filter((row) => machineSlotIds.includes(row.machine_slot_id))
      .map((row) => row.machine_id);
    return new Set([...machineIds, ...recommendedMachines]).size;
  }, [machineIds, machineSlotIds, recommendations]);

  const toggleValue = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

  const validate = () => {
    if (!routeDate) return "Route date is required.";
    if (!operatorId) return "Operator is required when creating an assigned route.";
    if (!machineIds.length && !machineSlotIds.length) return "Select at least one machine stop or refill recommendation.";
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
        body: JSON.stringify({ routeDate, operatorId, machineIds, machineSlotIds }),
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
                    <td className="px-3 py-2 font-semibold">{row.suggested_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
