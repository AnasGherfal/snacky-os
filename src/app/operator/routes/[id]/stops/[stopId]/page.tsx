"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ClientAppShell as AppShell } from "@/components/ClientAppShell";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { EmptyState, ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { completeStop } from "@/lib/operator-actions";

const reasonOptions = [
  "Product not available in storage",
  "Product not in operator bag",
  "Machine slot changed",
  "Product expired/damaged",
  "Customer demand",
  "Other",
];

interface StopRefillItem {
  refillOrderLineId?: string | null;
  machineSlotId: string | null;
  slotCode: string;
  productId: string;
  productName: string;
  currentQty: number;
  assignedQty?: number;
  parQty: number;
  availableQty?: number;
  filledQty: number;
}

interface ProductOption {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  availableQty: number;
}

interface StopData {
  stopId: string;
  routeId: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  location: string;
  refillItems: StopRefillItem[];
  productOptions: ProductOption[];
  debug?: StopDebugDetails;
}

interface StopDebugDetails {
  authUserId: string | null;
  matchedTeamMemberId: string | null;
  routeId: string;
  stopId: string;
  routeOperatorId: string | null;
  routeStopRouteId: string | null;
}

interface StopLoadError {
  title: string;
  body: string;
  debug?: StopDebugDetails;
}

interface ExtraProductLine {
  id: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}

interface SubstitutionLine {
  id: string;
  assignedProductId: string;
  substituteProductId: string;
  quantity: number;
  reason: string;
  notes: string;
}

interface MissingProductReport {
  id: string;
  productName: string;
  reason: string;
  notes: string;
}

function newClientId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function MachineStopPage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[]; stopId?: string | string[] }>();
  const rawRouteId = params?.id;
  const rawStopId = params?.stopId;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const stopId = Array.isArray(rawStopId) ? rawStopId[0] ?? "" : rawStopId ?? "";
  const routeHref = routeId ? `/operator/routes/${routeId}` : "/operator";

  const [stopData, setStopData] = useState<StopData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState<StopLoadError | null>(null);
  const [cashCollected, setCashCollected] = useState(0);
  const [notes, setNotes] = useState("");
  const [issueType, setIssueType] = useState("");
  const [issuePriority, setIssuePriority] = useState<"critical" | "high" | "normal" | "low">("normal");
  const [issueDescription, setIssueDescription] = useState("");
  const [filledQtys, setFilledQtys] = useState<Record<string, number>>({});
  const [lineNotes, setLineNotes] = useState<Record<string, string>>({});
  const [unavailableProducts, setUnavailableProducts] = useState<Record<string, boolean>>({});
  const [extraProducts, setExtraProducts] = useState<ExtraProductLine[]>([]);
  const [substitutions, setSubstitutions] = useState<SubstitutionLine[]>([]);
  const [missingReports, setMissingReports] = useState<MissingProductReport[]>([]);
  const [showCleaningChecklist, setShowCleaningChecklist] = useState(false);
  const [cleaningDone, setCleaningDone] = useState(false);
  const [finalPhotoName, setFinalPhotoName] = useState("");

  const productById = useMemo(() => new Map((stopData?.productOptions ?? []).map((product) => [product.id, product])), [stopData]);
  const assignedByProduct = useMemo(() => new Map((stopData?.refillItems ?? []).map((item) => [item.productId, item])), [stopData]);
  const reservedByProduct = useMemo(() => {
    const reserved = new Map<string, number>();
    Object.entries(filledQtys).forEach(([productId, quantity]) => reserved.set(productId, (reserved.get(productId) ?? 0) + Number(quantity ?? 0)));
    extraProducts.forEach((line) => reserved.set(line.productId, (reserved.get(line.productId) ?? 0) + Number(line.quantity ?? 0)));
    substitutions.forEach((line) => reserved.set(line.substituteProductId, (reserved.get(line.substituteProductId) ?? 0) + Number(line.quantity ?? 0)));
    return reserved;
  }, [filledQtys, extraProducts, substitutions]);

  useEffect(() => {
    const fetchStopData = async () => {
      if (!routeId || !stopId) {
        setLoadError({
          title: "Stop link incomplete",
          body: "Route or stop id is missing. Go back to your route and open the stop again.",
        });
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}`);
        const data = await response.json();
        if (!response.ok) {
          const serverMessage = data.error || "Failed to load stop data";
          const details = process.env.NODE_ENV === "development" && data.details ? ` ${data.details}` : "";
          const debug = data.debug as StopDebugDetails | undefined;

          if (response.status === 403 || data.code === "UNAUTHORIZED") {
            setLoadError({ title: "Unauthorized", body: `${serverMessage}${details}`, debug });
            return;
          }

          if (data.code === "STOP_NOT_FOUND") {
            setLoadError({ title: "Stop unavailable", body: "This stop no longer exists.", debug });
            return;
          }

          setLoadError({
            title: data.code === "STOP_ROUTE_MISMATCH" ? "Stop route mismatch" : "Stop could not be loaded",
            body: `${serverMessage}${details}`,
            debug,
          });
          return;
        }

        setStopData(data);
        const initialQtys: Record<string, number> = {};
        data.refillItems?.forEach((item: StopRefillItem) => {
          const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
          initialQtys[item.productId] = Math.min(assignedQty, item.availableQty ?? assignedQty);
        });
        setFilledQtys(initialQtys);
      } catch (err) {
        setLoadError({
          title: "Stop could not be loaded",
          body: err instanceof Error ? err.message : "Failed to load stop data",
        });
      } finally {
        setLoading(false);
      }
    };
    fetchStopData();
  }, [routeId, stopId]);

  const remainingBagQty = (productId: string, excluding = 0) => {
    const available = productById.get(productId)?.availableQty ?? assignedByProduct.get(productId)?.availableQty ?? 0;
    const reserved = reservedByProduct.get(productId) ?? 0;
    return Math.max(0, available - reserved + excluding);
  };

  const setAssignedQty = (item: StopRefillItem, quantity: number) => {
    const current = filledQtys[item.productId] ?? 0;
    const max = remainingBagQty(item.productId, current);
    setFilledQtys((prev) => ({ ...prev, [item.productId]: Math.max(0, Math.min(max, quantity)) }));
    if (quantity > max) setError("Actual filled quantity cannot exceed what is available in the operator bag.");
  };

  const addExtraProduct = () => {
    setExtraProducts((prev) => [...prev, { id: newClientId(), productId: "", quantity: 0, reason: "Customer demand", notes: "" }]);
  };

  const addSubstitution = () => {
    setSubstitutions((prev) => [...prev, { id: newClientId(), assignedProductId: "", substituteProductId: "", quantity: 0, reason: "Product not in operator bag", notes: "" }]);
  };

  const addMissingReport = () => {
    setMissingReports((prev) => [...prev, { id: newClientId(), productName: "", reason: "Other", notes: "" }]);
  };

  const updateExtra = (id: string, patch: Partial<ExtraProductLine>) => {
    setExtraProducts((prev) => prev.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const updateSubstitution = (id: string, patch: Partial<SubstitutionLine>) => {
    setSubstitutions((prev) => prev.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const updateMissingReport = (id: string, patch: Partial<MissingProductReport>) => {
    setMissingReports((prev) => prev.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const handleCompleteStop = async () => {
    if (!stopData) return;
    if (!cleaningDone) {
      setError("Please complete the cleaning checklist before finishing.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await completeStop({
        stopId,
        routeId,
        machineId: stopData.machineId,
        filledItems: stopData.refillItems.map((item) => ({
          refillOrderLineId: item.refillOrderLineId ?? null,
          productId: item.productId,
          quantity: filledQtys[item.productId] || 0,
          assignedQty: Number(item.assignedQty ?? item.parQty ?? 0),
          reason: unavailableProducts[item.productId] ? "Product not in operator bag" : undefined,
          notes: lineNotes[item.productId] || undefined,
          unavailable: Boolean(unavailableProducts[item.productId]),
        })),
        extraItems: extraProducts
          .filter((item) => item.productId && item.quantity > 0)
          .map((item) => ({ productId: item.productId, quantity: item.quantity, reason: item.reason, notes: item.notes || undefined })),
        substitutions: substitutions
          .filter((item) => item.assignedProductId && item.substituteProductId && item.quantity > 0)
          .map((item) => ({ assignedProductId: item.assignedProductId, substituteProductId: item.substituteProductId, quantity: item.quantity, reason: item.reason, notes: item.notes || undefined })),
        missingProducts: missingReports
          .filter((item) => item.productName.trim())
          .map((item) => ({ productName: item.productName.trim(), reason: item.reason, notes: item.notes || undefined })),
        cashCollected,
        notes,
        issue: issueType && issueDescription ? { issueType, priority: issuePriority, description: issueDescription } : undefined,
      });

      router.push(routeHref);
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
        <div className="space-y-4">
          <ErrorState
            title={loadError?.title ?? "Stop could not be loaded"}
            body={loadError?.body ?? "Failed to load machine stop details."}
            action={<SecondaryButton href={routeHref}>Back to route</SecondaryButton>}
          />
          {loadError?.debug ? <DebugDetails debug={loadError.debug} /> : null}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-5xl space-y-6">
        <PageHeader
          title={stopData.machineName}
          subtitle={`${stopData.machineCode} - ${stopData.location}`}
          action={<SecondaryButton href={routeHref}>Back</SecondaryButton>}
        />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 p-4 md:p-6">
            <h2 className="text-lg font-semibold">Assigned products</h2>
            <p className="mt-1 text-sm text-slate-500">Record actual quantities. Differences from the plan are tracked for review.</p>
          </div>

          {stopData.refillItems.length === 0 ? (
            <div className="p-4 md:p-6">
              <EmptyState title="No refill items assigned to this stop." body="You can still add extra products, collect cash, report issues, and complete the stop." />
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {stopData.refillItems.map((item) => {
                const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
                const actualQty = filledQtys[item.productId] || 0;
                const difference = actualQty - assignedQty;
                const maxQty = remainingBagQty(item.productId, actualQty);
                return (
                  <div key={`${item.refillOrderLineId ?? item.productId}-${item.slotCode}`} className="space-y-4 p-4 md:p-6">
                    <div className="grid gap-3 md:grid-cols-5">
                      <div className="md:col-span-2">
                        <p className="text-xs text-slate-500">Product</p>
                        <p className="font-semibold text-slate-900">{item.productName}</p>
                        <p className="text-sm text-slate-500">Slot {item.slotCode}</p>
                      </div>
                      <Metric label="Assigned" value={assignedQty} />
                      <Metric label="Bag available" value={item.availableQty ?? 0} />
                      <Metric label="Difference" value={difference > 0 ? `+${difference}` : difference} tone={difference === 0 ? "neutral" : "warn"} />
                    </div>
                    <div className="grid gap-3 md:grid-cols-[160px_1fr]">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Actual filled qty</span>
                        <input
                          type="number"
                          min="0"
                          max={maxQty}
                          value={actualQty}
                          onChange={(event) => setAssignedQty(item, parseInt(event.target.value) || 0)}
                          disabled={unavailableProducts[item.productId]}
                          className="field-input"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Notes for change</span>
                        <input
                          value={lineNotes[item.productId] ?? ""}
                          onChange={(event) => setLineNotes((prev) => ({ ...prev, [item.productId]: event.target.value }))}
                          className="field-input"
                          placeholder="Explain shortage, overfill, or condition"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={Boolean(unavailableProducts[item.productId])}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setUnavailableProducts((prev) => ({ ...prev, [item.productId]: checked }));
                          if (checked) setFilledQtys((prev) => ({ ...prev, [item.productId]: 0 }));
                        }}
                      />
                      Mark assigned product as unavailable
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Products added at machine</h2>
              <p className="mt-1 text-sm text-slate-500">Add unplanned products or substitutions from the operator bag. These lines are saved when you complete the stop.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={addExtraProduct} className="btn-secondary">Add product</button>
              <button type="button" onClick={addSubstitution} className="btn-secondary">Swap product</button>
              <button type="button" onClick={addMissingReport} className="btn-secondary">Report missing</button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {extraProducts.map((line) => {
              const selected = productById.get(line.productId);
              const maxQty = line.productId ? remainingBagQty(line.productId, line.quantity) : 0;
              return (
                <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 md:grid-cols-[1fr_120px_1fr]">
                    <ProductPicker products={stopData.productOptions} value={line.productId} onChange={(productId) => updateExtra(line.id, { productId, quantity: 0 })} label="Extra product" />
                    <QuantityInput value={line.quantity} max={maxQty} onChange={(quantity) => updateExtra(line.id, { quantity })} />
                    <ReasonSelect value={line.reason} onChange={(reason) => updateExtra(line.id, { reason })} />
                  </div>
                  <input value={line.notes} onChange={(event) => updateExtra(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder={`Notes${selected ? ` for ${selected.name}` : ""}`} />
                  <button type="button" onClick={() => setExtraProducts((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
                </div>
              );
            })}

            {substitutions.map((line) => {
              const maxQty = line.substituteProductId ? remainingBagQty(line.substituteProductId, line.quantity) : 0;
              return (
                <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-slate-800">Original assigned product</span>
                      <select value={line.assignedProductId} onChange={(event) => updateSubstitution(line.id, { assignedProductId: event.target.value })} className="field-input">
                        <option value="">Select assigned product</option>
                        {stopData.refillItems.map((item) => <option key={item.productId} value={item.productId}>{item.productName}</option>)}
                      </select>
                    </label>
                    <ProductPicker products={stopData.productOptions} value={line.substituteProductId} onChange={(productId) => updateSubstitution(line.id, { substituteProductId: productId, quantity: 0 })} label="Replacement product" />
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-[120px_1fr]">
                    <QuantityInput value={line.quantity} max={maxQty} onChange={(quantity) => updateSubstitution(line.id, { quantity })} />
                    <ReasonSelect value={line.reason} onChange={(reason) => updateSubstitution(line.id, { reason })} />
                  </div>
                  <input value={line.notes} onChange={(event) => updateSubstitution(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder="Notes" />
                  <button type="button" onClick={() => setSubstitutions((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
                </div>
              );
            })}

            {missingReports.map((line) => (
              <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-800">Missing product name</span>
                    <input value={line.productName} onChange={(event) => updateMissingReport(line.id, { productName: event.target.value })} className="field-input" placeholder="Type product name from machine" />
                  </label>
                  <ReasonSelect value={line.reason} onChange={(reason) => updateMissingReport(line.id, { reason })} />
                </div>
                <input value={line.notes} onChange={(event) => updateMissingReport(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder="Notes" />
                <button type="button" onClick={() => setMissingReports((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
              </div>
            ))}

            {!extraProducts.length && !substitutions.length && !missingReports.length ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No extra products, swaps, or missing product reports added.</p>
            ) : null}
          </div>
        </section>

        <CashAndIssueSections
          cashCollected={cashCollected}
          setCashCollected={setCashCollected}
          notes={notes}
          setNotes={setNotes}
          issueType={issueType}
          setIssueType={setIssueType}
          issuePriority={issuePriority}
          setIssuePriority={setIssuePriority}
          issueDescription={issueDescription}
          setIssueDescription={setIssueDescription}
        />

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-2 text-lg font-semibold">Final photo</h2>
          <p className="mb-4 text-sm text-slate-500">Take this after filling the machine and cleaning the glass.</p>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => setFinalPhotoName(event.target.files?.[0]?.name ?? "")}
            className="field-input"
          />
          {finalPhotoName ? <p className="mt-2 text-sm text-slate-600">Selected: {finalPhotoName}</p> : null}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-4 text-lg font-semibold">Cleaning and final check</h2>
          <button type="button" onClick={() => setShowCleaningChecklist(!showCleaningChecklist)} className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-left transition hover:bg-slate-100">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900">Checklist</span>
              <span className={cleaningDone ? "font-semibold text-green-600" : "text-slate-600"}>{cleaningDone ? "Completed" : "Open"}</span>
            </div>
          </button>
          {showCleaningChecklist && (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={cleaningDone} onChange={(event) => setCleaningDone(event.target.checked)} className="mt-1" />
                <div>
                  <p className="font-medium text-slate-900">I have completed all checks:</p>
                  <ul className="mt-2 ml-2 list-disc space-y-1 text-sm text-slate-600">
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

        <div className="sticky bottom-4 flex gap-3">
          <SecondaryButton href={routeHref} type="button">Cancel</SecondaryButton>
          <button onClick={handleCompleteStop} disabled={submitting || !cleaningDone} className="btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? "Completing..." : "Complete Stop"}
          </button>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <strong>Reminder:</strong> This page is for physical execution at the machine: actual filled quantities, shortage reasons, cash, issues, and the final photo after cleaning.
        </div>

        {stopData.debug ? <DebugDetails debug={stopData.debug} /> : null}
      </div>
    </AppShell>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: number | string; tone?: "neutral" | "warn" }) {
  return (
    <div className={tone === "warn" ? "rounded-lg border border-amber-200 bg-amber-50 p-3" : "rounded-lg border border-slate-200 bg-white p-3"}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function ProductPicker({ products, value, onChange, label = "Existing product" }: { products: ProductOption[]; value: string; onChange: (productId: string) => void; label?: string }) {
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products.slice(0, 8);
    return products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((field) => String(field ?? "").toLowerCase().includes(needle))).slice(0, 8);
  }, [products, query]);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border-0 px-2 py-2 text-sm outline-none ring-0"
          placeholder={selected ? `${selected.name} - ${selected.sku ?? "No SKU"}` : "Search name, SKU, barcode, category, or brand"}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800">
              Selected: {selected.name} - Bag {selected.availableQty}
            </div>
          ) : null}
        {filtered.map((product) => (
          <button
            key={product.id}
            type="button"
            onClick={() => {
              onChange(product.id);
              setQuery("");
            }}
            className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${product.id === value ? "bg-blue-600 text-white" : "hover:bg-slate-100"}`}
          >
            <span className="flex items-center gap-3">
              <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{product.name}</span>
                <span className={product.id === value ? "text-blue-100" : "text-slate-500"}>{product.sku ?? "No SKU"} - Bag {product.availableQty}</span>
              </span>
            </span>
          </button>
        ))}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">No products found.</p> : null}
        </div>
      </div>
    </div>
  );
}

function QuantityInput({ value, max, onChange }: { value: number; max: number; onChange: (quantity: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">Quantity</span>
      <input type="number" min="0" max={max} value={value} onChange={(event) => onChange(Math.max(0, Math.min(max, parseInt(event.target.value) || 0)))} className="field-input" />
      <span className="mt-1 block text-xs text-slate-500">Bag available: {max}</span>
    </label>
  );
}

function ReasonSelect({ value, onChange }: { value: string; onChange: (reason: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="field-input">
        {reasonOptions.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
      </select>
    </label>
  );
}

function CashAndIssueSections({
  cashCollected,
  setCashCollected,
  notes,
  setNotes,
  issueType,
  setIssueType,
  issuePriority,
  setIssuePriority,
  issueDescription,
  setIssueDescription,
}: {
  cashCollected: number;
  setCashCollected: (value: number) => void;
  notes: string;
  setNotes: (value: string) => void;
  issueType: string;
  setIssueType: (value: string) => void;
  issuePriority: "critical" | "high" | "normal" | "low";
  setIssuePriority: (value: "critical" | "high" | "normal" | "low") => void;
  issueDescription: string;
  setIssueDescription: (value: string) => void;
}) {
  return (
    <>
      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">Cash Collection</h2>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Actual cash collected</span>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">LYD</span>
              <input type="number" step="0.01" min="0" value={cashCollected} onChange={(event) => setCashCollected(parseFloat(event.target.value) || 0)} className="field-input flex-1" placeholder="0.00" />
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Stop notes</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} className="field-input" rows={3} placeholder="Any notes about this stop?" />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">Issue Report</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Issue type</span>
            <input value={issueType} onChange={(event) => setIssueType(event.target.value)} className="field-input" placeholder="e.g. cash jam, display error, cooling issue" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Priority</span>
            <select value={issuePriority} onChange={(event) => setIssuePriority(event.target.value as typeof issuePriority)} className="field-input">
              <option value="normal">Normal</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-800">Description</span>
            <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} className="field-input" rows={3} placeholder="Describe the problem only if there is an issue to report." />
          </label>
        </div>
      </section>
    </>
  );
}

function DebugDetails({ debug }: { debug: StopDebugDetails }) {
  if (process.env.NODE_ENV !== "development") return null;

  const rows = [
    ["auth user id", debug.authUserId],
    ["matched team_member id", debug.matchedTeamMemberId],
    ["route id", debug.routeId],
    ["stop id", debug.stopId],
    ["route.operator_id", debug.routeOperatorId],
    ["route_stop.route_id", debug.routeStopRouteId],
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Development debug</h2>
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium text-slate-700">{label}</dt>
            <dd className="break-all font-mono">{value ?? "none"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
