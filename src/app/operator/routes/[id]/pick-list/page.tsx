"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { confirmPickList, startRoute } from "@/lib/operator-actions";

interface PickItem {
  productId: string;
  productName: string;
  sku: string | null;
  requestedQty: number;
  availableStorageQty: number;
  confirmedQty: number;
  reason: string;
  notes: string;
  machineItems: { machineName: string; machineCode: string; plannedQty: number; source: string }[];
}
interface ProductOption {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  availableStorageQty: number;
}
interface ExtraPickItem {
  id: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}
interface SubPickItem {
  id: string;
  plannedProductId: string;
  substituteProductId: string;
  quantity: number;
  reason: string;
  notes: string;
}

function safeRouteHref(routeId: string) {
  return routeId ? `/operator/routes/${routeId}` : "/operator";
}

export default function PickListPage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[] }>();
  const searchParams = useSearchParams();
  const rawRouteId = params?.id;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const routeHref = safeRouteHref(routeId);
  const shouldStartRoute = searchParams.get("start") === "1";
  const startAttempted = useRef(false);
  const [pickItems, setPickItems] = useState<PickItem[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [extras, setExtras] = useState<ExtraPickItem[]>([]);
  const [substitutions, setSubstitutions] = useState<SubPickItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const fetchPickList = async () => {
      if (!routeId) {
        setError("Route id is missing. Go back to your operator routes and open the route again.");
        setLoading(false);
        return;
      }

      try {
        if (shouldStartRoute && !startAttempted.current) {
          startAttempted.current = true;
          await startRoute(routeId);
          setNotice("Route started.");
        }

        const response = await fetch(`/api/operator/routes/${routeId}/pick-list`);
        const data = await response.json();
        if (!response.ok) {
          const message = process.env.NODE_ENV === "development" && data.details ? `${data.error}: ${data.details}` : data.error;
          throw new Error(message || "Failed to fetch pick list");
        }

        setPickItems(
          data.items.map((item: any) => ({
            productId: item.product_id,
            productName: item.product_name,
            sku: item.sku ?? null,
            requestedQty: Number(item.planned_qty ?? 0),
            availableStorageQty: Number(item.available_storage_qty ?? 0),
            confirmedQty: Number(item.picked_qty ?? item.planned_qty ?? 0),
            reason: "Product not available in storage",
            notes: "",
            machineItems: (item.machine_items ?? []).map((machine: any) => ({
              machineName: machine.machine_name,
              machineCode: machine.machine_code,
              plannedQty: Number(machine.planned_qty ?? 0),
              source: machine.source ?? "refill_recommendation",
            })),
          })),
        );
        setProductOptions(data.productOptions ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load pick list");
      } finally {
        setLoading(false);
      }
    };
    fetchPickList();
  }, [routeId, shouldStartRoute]);

  const handleConfirmPick = async () => {
    setSubmitting(true);
    setError("");
    try {
      const items = pickItems.map((item) => ({
        productId: item.productId,
        quantity: item.confirmedQty,
        plannedQty: item.requestedQty,
        reason: item.reason,
        notes: item.notes,
      }));
      await confirmPickList(
        routeId,
        items,
        extras.filter((item) => item.productId && item.quantity > 0).map((item) => ({ productId: item.productId, quantity: item.quantity, reason: item.reason, notes: item.notes })),
        substitutions
          .filter((item) => item.plannedProductId && item.substituteProductId && item.quantity > 0)
          .map((item) => ({ plannedProductId: item.plannedProductId, substituteProductId: item.substituteProductId, quantity: item.quantity, reason: item.reason, notes: item.notes })),
      );
      router.push(routeHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm pick list");
      setSubmitting(false);
    }
  };

  const updatePickItem = (productId: string, patch: Partial<PickItem>) => {
    setPickItems((prev) => prev.map((item) => (item.productId === productId ? { ...item, ...patch } : item)));
  };
  const addExtra = () => setExtras((prev) => [...prev, { id: crypto.randomUUID(), productId: "", quantity: 0, reason: "Customer demand", notes: "" }]);
  const addSubstitution = () => setSubstitutions((prev) => [...prev, { id: crypto.randomUUID(), plannedProductId: "", substituteProductId: "", quantity: 0, reason: "Product not available in storage", notes: "" }]);

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-12">
          <p className="text-slate-500">Loading pick list...</p>
        </div>
      </AppShell>
    );
  }

  if (!routeId) {
    return (
      <AppShell>
        <ErrorState
          title="Route id missing"
          body="This pick-list page was opened without a valid route id."
          action={<SecondaryButton href="/operator">Back to operator home</SecondaryButton>}
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-3xl space-y-6">
        <PageHeader title="Pick List" subtitle="Confirm what you actually take from storage before leaving." action={<SecondaryButton href={routeHref}>Cancel</SecondaryButton>} />

        {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{notice}</div> : null}
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        {pickItems.length === 0 ? (
          <EmptyState title="No pick-list items were added to this route." body="Ask an admin to add machine-level refill items before picking stock." />
        ) : (
          <>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
              <strong>Instructions:</strong> This route pick list is calculated from each machine stop plan. Confirm actual picked quantities before leaving storage.
            </div>

            <div className="space-y-3">
              {pickItems.map((item) => (
                <div key={item.productId} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">{item.productName}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        SKU: {item.sku ?? "No SKU"} - Planned total: {item.requestedQty} units - Storage: {item.availableStorageQty}
                      </p>
                      <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {item.machineItems.map((machine, index) => (
                          <div key={`${machine.machineCode}-${index}`} className="flex justify-between gap-3 text-xs text-slate-600">
                            <span>{machine.machineName} ({machine.machineCode})</span>
                            <span>{machine.plannedQty} - {machine.source === "manual_admin_assignment" ? "manual" : "recommendation"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-end gap-2">
                      <input
                        type="number"
                        min="0"
                        max={item.requestedQty}
                        value={item.confirmedQty}
                        onChange={(event) => updatePickItem(item.productId, { confirmedQty: Math.max(0, Math.min(item.requestedQty, parseInt(event.target.value) || 0)) })}
                        className="field-input w-20"
                      />
                      <span className="mb-2 text-xs text-slate-500">units</span>
                    </div>
                  </div>

                  {item.confirmedQty !== item.requestedQty ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
                        <select value={item.reason} onChange={(event) => updatePickItem(item.productId, { reason: event.target.value })} className="field-input">
                          <option>Product not available in storage</option>
                          <option>Product not in operator bag</option>
                          <option>Product expired/damaged</option>
                          <option>Customer demand</option>
                          <option>Other</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
                        <input value={item.notes} onChange={(event) => updatePickItem(item.productId, { notes: event.target.value })} className="field-input" placeholder="Explain the pick-list change" />
                      </label>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <SectionCard>
              <div className="grid grid-cols-2 gap-4 p-4">
                <div>
                  <p className="mb-1 text-xs text-slate-500">Products</p>
                  <p className="text-2xl font-bold text-slate-900">{pickItems.length}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs text-slate-500">Picked units</p>
                  <p className="text-2xl font-bold text-slate-900">{pickItems.reduce((sum, item) => sum + item.confirmedQty, 0)}</p>
                </div>
              </div>
            </SectionCard>

            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-900">Operator adjustments before leaving storage</h2>
                  <p className="text-sm text-slate-500">Extras and substitutions are flagged for supervisor review.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary" onClick={addExtra}>Add extra product</button>
                  <button type="button" className="btn-secondary" onClick={addSubstitution}>Substitute</button>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {extras.map((item) => (
                  <AdjustmentRow
                    key={item.id}
                    products={productOptions}
                    label="Extra product"
                    productId={item.productId}
                    quantity={item.quantity}
                    reason={item.reason}
                    notes={item.notes}
                    onChange={(patch) => setExtras((prev) => prev.map((row) => row.id === item.id ? { ...row, ...patch } : row))}
                    onRemove={() => setExtras((prev) => prev.filter((row) => row.id !== item.id))}
                  />
                ))}
                {substitutions.map((item) => (
                  <div key={item.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Original planned product</span>
                        <select value={item.plannedProductId} onChange={(event) => setSubstitutions((prev) => prev.map((row) => row.id === item.id ? { ...row, plannedProductId: event.target.value } : row))} className="field-input">
                          <option value="">Select planned product</option>
                          {pickItems.map((planned) => <option key={planned.productId} value={planned.productId}>{planned.productName}</option>)}
                        </select>
                      </label>
                      <AdjustmentRow
                        products={productOptions}
                        label="Substitute product"
                        productId={item.substituteProductId}
                        quantity={item.quantity}
                        reason={item.reason}
                        notes={item.notes}
                        onChange={(patch) => setSubstitutions((prev) => prev.map((row) => row.id === item.id ? { ...row, substituteProductId: patch.productId ?? row.substituteProductId, quantity: patch.quantity ?? row.quantity, reason: patch.reason ?? row.reason, notes: patch.notes ?? row.notes } : row))}
                        onRemove={() => setSubstitutions((prev) => prev.filter((row) => row.id !== item.id))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="flex gap-3">
              <SecondaryButton href={routeHref} type="button">Cancel</SecondaryButton>
              <button onClick={handleConfirmPick} disabled={submitting} className="btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? "Confirming..." : "Confirm Pick List"}
              </button>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function AdjustmentRow({
  products,
  label,
  productId,
  quantity,
  reason,
  notes,
  onChange,
  onRemove,
}: {
  products: ProductOption[];
  label: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
  onChange: (patch: Partial<ExtraPickItem>) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === productId);
  const filtered = products
    .filter((product) => !query.trim() || [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query.trim().toLowerCase())))
    .slice(0, 8);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_120px_1fr]">
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-md border-0 px-2 py-2 text-sm outline-none ring-0" placeholder={selected ? `${selected.name} - ${selected.sku ?? "No SKU"}` : "Search name, SKU, barcode, category, brand"} />
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {selected && !query.trim() ? (
                <div className="rounded-md bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800">
                  Selected: {selected.name} - Storage {selected.availableStorageQty}
                </div>
              ) : null}
              {filtered.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => {
                    onChange({ productId: product.id, quantity: 0 });
                    setQuery("");
                  }}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${product.id === productId ? "bg-blue-600 text-white" : "hover:bg-slate-100"}`}
                >
                  <span className="block font-medium">{product.name}</span>
                  <span className={product.id === productId ? "text-blue-100" : "text-slate-500"}>{product.sku ?? "No SKU"} - Storage {product.availableStorageQty}</span>
                </button>
              ))}
              {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">No products found.</p> : null}
            </div>
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Qty</span>
          <input type="number" min="0" max={selected?.availableStorageQty ?? 0} value={quantity} onChange={(event) => onChange({ quantity: Math.max(0, Math.min(selected?.availableStorageQty ?? 0, parseInt(event.target.value) || 0)) })} className="field-input" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
          <select value={reason} onChange={(event) => onChange({ reason: event.target.value })} className="field-input">
            <option>Product not available in storage</option>
            <option>Product expired/damaged</option>
            <option>Customer demand</option>
            <option>Other</option>
          </select>
        </label>
      </div>
      <input value={notes} onChange={(event) => onChange({ notes: event.target.value })} className="field-input mt-3" placeholder="Notes" />
      <button type="button" onClick={onRemove} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
    </div>
  );
}
