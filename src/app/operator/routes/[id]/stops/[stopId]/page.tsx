"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PageHeader, SecondaryButton, SectionCard, PrimaryButton } from "@/components/ui";
import { completeStop } from "@/lib/operator-actions";

interface StopRefillItem {
  machineSlotId: string;
  slotCode: string;
  productId: string;
  productName: string;
  currentQty: number;
  parQty: number;
  availableQty?: number;
  filledQty: number;
}

interface StopData {
  stopId: string;
  routeId: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  location: string;
  refillItems: StopRefillItem[];
}

export default function MachineStopPage({
  params,
}: {
  params: { id: string; stopId: string };
}) {
  const router = useRouter();
  const routeId = params.id;
  const stopId = params.stopId;

  const [stopData, setStopData] = useState<StopData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [cashCollected, setCashCollected] = useState(0);
  const [notes, setNotes] = useState("");
  const [issueType, setIssueType] = useState("");
  const [issuePriority, setIssuePriority] = useState<"critical" | "high" | "normal" | "low">("normal");
  const [issueDescription, setIssueDescription] = useState("");
  const [filledQtys, setFilledQtys] = useState<Record<string, number>>({});
  const [showCleaningChecklist, setShowCleaningChecklist] = useState(false);
  const [cleaningDone, setCleaningDone] = useState(false);

  useEffect(() => {
    const fetchStopData = async () => {
      try {
        const response = await fetch(
          `/api/operator/routes/${routeId}/stops/${stopId}`
        );
        if (!response.ok) throw new Error("Failed to fetch stop data");
        const data = await response.json();
        setStopData(data);
        const initialQtys: Record<string, number> = {};
        data.refillItems?.forEach((item: StopRefillItem) => {
          initialQtys[item.productId] = Math.min(item.parQty, item.availableQty ?? item.parQty);
        });
        setFilledQtys(initialQtys);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load stop data");
      } finally {
        setLoading(false);
      }
    };
    fetchStopData();
  }, [routeId, stopId]);

  const handleCompleteStop = async () => {
    if (!stopData) return;
    if (!cleaningDone) {
      setError("Please complete the cleaning checklist before finishing.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const filledItems = stopData.refillItems.map((item) => ({
        productId: item.productId,
        quantity: filledQtys[item.productId] || 0,
      }));

      await completeStop({
        stopId,
        routeId,
        machineId: stopData.machineId,
        filledItems,
        cashCollected,
        notes,
        issue: issueType && issueDescription ? { issueType, priority: issuePriority, description: issueDescription } : undefined,
      });

      router.push(`/operator/routes/${routeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete stop");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-12">
          <p className="text-slate-500">Loading machine details...</p>
        </div>
      </AppShell>
    );
  }

  if (!stopData) {
    return (
      <AppShell>
        <div className="rounded-lg bg-red-50 border border-red-200 p-8 text-center">
          <p className="text-red-700">Failed to load machine stop details.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6 max-w-4xl">
        <PageHeader
          title={stopData.machineName}
          subtitle={`${stopData.machineCode} - ${stopData.location}`}
          action={<SecondaryButton href={`/operator/routes/${routeId}`}>Back</SecondaryButton>}
        />

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Refill Items */}
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="p-4 md:p-6 border-b border-slate-200 bg-slate-50">
            <h2 className="text-lg font-semibold">Fill Machine</h2>
            <p className="text-sm text-slate-500 mt-1">
              Enter the actual quantities you filled in each slot.
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {stopData.refillItems.length === 0 ? (
              <div className="p-6 text-center text-slate-500">
                No items to refill at this machine.
              </div>
            ) : (
              stopData.refillItems.map((item) => (
                <div key={item.productId} className="p-4 md:p-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Slot</p>
                      <p className="font-semibold text-slate-900">{item.slotCode}</p>
                      <p className="text-sm text-slate-600">{item.productName}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500 mb-1">Actual quantity filled</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          max={item.availableQty ?? item.parQty}
                          value={filledQtys[item.productId] || 0}
                          onChange={(e) =>
                            setFilledQtys((prev) => ({
                              ...prev,
                              [item.productId]: Math.max(0, Math.min(item.availableQty ?? item.parQty, parseInt(e.target.value) || 0)),
                            }))
                          }
                          className="field-input w-24"
                        />
                        <span className="text-sm text-slate-600">units (available: {item.availableQty ?? item.parQty})</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Cash Collection */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Cash Collection</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">
                Actual cash collected
              </label>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">LYD</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cashCollected}
                  onChange={(e) => setCashCollected(parseFloat(e.target.value) || 0)}
                  className="field-input flex-1"
                  placeholder="0.00"
                />
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Enter the exact amount you collected from this machine.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">
                Notes (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="field-input"
                placeholder="Any notes about this stop? (e.g., machine error, cash jam, etc.)"
                rows={3}
              />
            </div>
          </div>
        </section>

        {/* Issue Report */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Issue Report</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">Issue type</label>
              <input
                value={issueType}
                onChange={(event) => setIssueType(event.target.value)}
                className="field-input"
                placeholder="e.g. cash jam, display error, cooling issue"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">Priority</label>
              <select value={issuePriority} onChange={(event) => setIssuePriority(event.target.value as typeof issuePriority)} className="field-input">
                <option value="normal">Normal</option>
                <option value="low">Low</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-800 mb-1">Description</label>
              <textarea
                value={issueDescription}
                onChange={(event) => setIssueDescription(event.target.value)}
                className="field-input"
                rows={3}
                placeholder="Describe the problem only if there is an issue to report."
              />
            </div>
          </div>
        </section>

        {/* Cleaning Checklist */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Cleaning & Final Check</h2>
          <button
            type="button"
            onClick={() => setShowCleaningChecklist(!showCleaningChecklist)}
            className="w-full text-left p-4 bg-slate-50 rounded-lg border border-slate-200 hover:bg-slate-100 transition"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900">Click to expand checklist</span>
              <span className={cleaningDone ? "text-green-600 font-semibold" : "text-slate-600"}>
                {cleaningDone ? "Completed" : "Open"}
              </span>
            </div>
          </button>

          {showCleaningChecklist && (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleaningDone}
                  onChange={(e) => setCleaningDone(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">I have completed all checks:</p>
                  <ul className="text-sm text-slate-600 mt-2 ml-2 space-y-1 list-disc">
                    <li>Machine exterior is clean</li>
                    <li>Display screen is working</li>
                    <li>All items are stocked correctly</li>
                    <li>No damaged or expired items visible</li>
                    <li>Machine is operating properly</li>
                  </ul>
                </div>
              </label>
            </div>
          )}
        </section>

        {/* Action Buttons */}
        <div className="flex gap-3 sticky bottom-4">
          <SecondaryButton
            href={`/operator/routes/${routeId}`}
            type="button"
          >
            Cancel
          </SecondaryButton>
          <button
            onClick={handleCompleteStop}
            disabled={submitting || !cleaningDone}
            className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Completing..." : "Complete Stop"}
          </button>
        </div>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
          <strong>Reminder:</strong> Complete the cleaning checklist before moving to the next machine. Report any issues immediately.
        </div>
      </div>
    </AppShell>
  );
}
