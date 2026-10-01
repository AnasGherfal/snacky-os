"use client";

import { useMemo, useState } from "react";

type MachineOption = {
  id: string;
  label: string;
};

type SelectedMachine = {
  amountLyd: string;
  boxKey: string;
};

type CashBoxDraft = {
  key: string;
  bagId: string;
};

const amountPattern = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;

function amountValue(value: string) {
  return amountPattern.test(value) ? Number(value) : 0;
}

export function CashRemovalBoxPlanner({
  machines,
  selectedMachineId,
}: {
  machines: MachineOption[];
  selectedMachineId?: string;
}) {
  const [boxes, setBoxes] = useState<CashBoxDraft[]>([{ key: "box-1", bagId: "" }]);
  const [selected, setSelected] = useState<Record<string, SelectedMachine>>(() =>
    selectedMachineId ? { [selectedMachineId]: { amountLyd: "", boxKey: "box-1" } } : {},
  );

  const assignedByBox = useMemo(() => {
    const map = new Map<string, { machineId: string; amountLyd: string }[]>();
    for (const box of boxes) map.set(box.key, []);
    for (const [machineId, value] of Object.entries(selected)) {
      const rows = map.get(value.boxKey) ?? [];
      rows.push({ machineId, amountLyd: value.amountLyd });
      map.set(value.boxKey, rows);
    }
    return map;
  }, [boxes, selected]);

  const plan = useMemo(() => ({
    boxes: boxes
      .map((box) => ({
        box_key: box.key,
        cash_bag_id: box.bagId.trim().toUpperCase(),
        machines: (assignedByBox.get(box.key) ?? []).map((row) => ({
          machine_id: row.machineId,
          removed_amount_lyd: row.amountLyd.trim(),
        })),
      }))
      .filter((box) => box.machines.length > 0),
  }), [assignedByBox, boxes]);

  function toggleMachine(machineId: string, checked: boolean) {
    setSelected((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[machineId];
        return next;
      }
      if (current[machineId]) return current;
      return { ...current, [machineId]: { amountLyd: "", boxKey: boxes[0]?.key ?? "box-1" } };
    });
  }

  function updateMachine(machineId: string, patch: Partial<SelectedMachine>) {
    setSelected((current) => ({
      ...current,
      [machineId]: { ...current[machineId], ...patch },
    }));
  }

  function addBox() {
    setBoxes((current) => {
      const nextNumber = current.reduce((max, box) => {
        const number = Number(box.key.replace(/^box-/, ""));
        return Number.isFinite(number) ? Math.max(max, number) : max;
      }, 0) + 1;
      return [...current, { key: `box-${nextNumber}`, bagId: "" }];
    });
  }

  function removeBox(key: string) {
    setBoxes((current) => {
      if (current.length <= 1) return current;
      const remaining = current.filter((box) => box.key !== key);
      const fallback = remaining[0].key;
      setSelected((selection) => Object.fromEntries(
        Object.entries(selection).map(([machineId, value]) => [
          machineId,
          value.boxKey === key ? { ...value, boxKey: fallback } : value,
        ]),
      ));
      return remaining;
    });
  }

  return (
    <div className="space-y-5">
      <textarea
        hidden
        aria-hidden="true"
        tabIndex={-1}
        name="cash_removal_plan"
        value={JSON.stringify(plan)}
        onChange={(event) => {
          try {
            const parsed = JSON.parse(event.target.value) as {
              boxes?: Array<{
                box_key?: string;
                cash_bag_id?: string;
                machines?: Array<{ machine_id?: string; removed_amount_lyd?: string }>;
              }>;
            };
            if (!Array.isArray(parsed.boxes) || parsed.boxes.length < 1) return;
            const nextBoxes: CashBoxDraft[] = [];
            const nextSelected: Record<string, SelectedMachine> = {};
            for (const candidate of parsed.boxes) {
              const key = String(candidate.box_key ?? "").trim();
              if (!key || nextBoxes.some((box) => box.key === key) || !Array.isArray(candidate.machines)) return;
              nextBoxes.push({ key, bagId: String(candidate.cash_bag_id ?? "").trim().toUpperCase() });
              for (const machine of candidate.machines) {
                const machineId = String(machine.machine_id ?? "").trim();
                if (!machineId || nextSelected[machineId]) return;
                nextSelected[machineId] = {
                  amountLyd: String(machine.removed_amount_lyd ?? "").trim(),
                  boxKey: key,
                };
              }
            }
            setBoxes(nextBoxes);
            setSelected(nextSelected);
          } catch {
            // Ignore malformed local draft text; the server validates the submitted plan.
          }
        }}
      />

      <div>
        <div className="text-sm font-semibold text-slate-900">Machines and removed amounts</div>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Select every machine, then enter the exact amount removed from that machine. All machines start in Box 1.
        </p>
        <div className="mt-3 grid gap-3">
          {machines.map((machine) => {
            const value = selected[machine.id];
            return (
              <div key={machine.id} className={`rounded-xl border p-3 ${value ? "border-emerald-300 bg-emerald-50/40" : "border-slate-200 bg-white"}`}>
                <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-slate-900">
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) => toggleMachine(machine.id, event.target.checked)}
                    className="h-4 w-4"
                  />
                  <span className="min-w-0 flex-1">{machine.label}</span>
                </label>

                {value ? (
                  <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                      Amount removed · LYD
                      <input
                        name={`machine_amount_${machine.id}`}
                        value={value.amountLyd}
                        onChange={(event) => updateMachine(machine.id, { amountLyd: event.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                        dir="ltr"
                        pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?"
                        required
                        placeholder="0.00"
                        className="field-input"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                      Physical cash box
                      <select
                        name={`machine_box_${machine.id}`}
                        value={value.boxKey}
                        onChange={(event) => updateMachine(machine.id, { boxKey: event.target.value })}
                        required
                        className="field-input"
                      >
                        {boxes.map((box, index) => (
                          <option key={box.key} value={box.key}>Box {index + 1}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">Physical cash boxes</div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              If several machines went into the same box, leave them assigned to the same box. Add another box only when you physically used another box or sealed bag.
            </p>
          </div>
          <button
            type="button"
            onClick={addBox}
            className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800"
          >
            + Add another box
          </button>
        </div>

        <div className="mt-3 grid gap-4">
          {boxes.map((box, index) => {
            const assigned = assignedByBox.get(box.key) ?? [];
            const used = assigned.length > 0;
            const total = assigned.reduce((sum, row) => sum + amountValue(row.amountLyd), 0);
            return (
              <section key={box.key} className={`rounded-2xl border p-4 ${used ? "border-slate-300 bg-white" : "border-dashed border-slate-200 bg-slate-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-950">Box {index + 1}</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {used ? `${assigned.length} machine${assigned.length === 1 ? "" : "s"} · declared ${total.toFixed(2)} LYD` : "No machines assigned yet"}
                    </p>
                  </div>
                  {boxes.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeBox(box.key)}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                    >
                      Remove box
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                    Box / seal ID
                    <input
                      name={`box_bag_id_${box.key}`}
                      value={box.bagId}
                      onChange={(event) => setBoxes((current) => current.map((row) => row.key === box.key ? { ...row, bagId: event.target.value.toUpperCase() } : row))}
                      required={used}
                      disabled={!used}
                      autoCapitalize="characters"
                      maxLength={120}
                      className="field-input uppercase disabled:bg-slate-100"
                      placeholder="Example: CASH-2026-1001-01"
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                    Photo of sealed box
                    <input
                      name={`box_evidence_${box.key}`}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      capture="environment"
                      required={used}
                      disabled={!used}
                      className="field-input disabled:bg-slate-100"
                    />
                  </label>
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
        <div className="font-semibold">One amount per machine, one custody trail per physical box</div>
        <p className="mt-1">
          Snacky keeps each machine amount separate. Machines sharing a box are grouped only for physical custody; different boxes remain separate through handover and counting.
        </p>
      </div>
    </div>
  );
}
