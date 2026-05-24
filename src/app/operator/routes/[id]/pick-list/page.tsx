"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { EmptyState, ErrorState, LoadingState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
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
  imageUrl?: string | null;
  availableStorageQty: number;
}
interface ExtraPickItem {
  id: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}
function safeRouteHref(routeId: string) {
  return routeId ? `/operator/routes/${routeId}` : "/operator";
}

function newExtraRow(): ExtraPickItem {
  return { id: crypto.randomUUID(), productId: "", quantity: 0, reason: "Customer demand", notes: "" };
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
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [locked, setLocked] = useState(false);
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

        const confirmed = Boolean(data.confirmed);
        setAlreadyConfirmed(confirmed);
        setLocked(Boolean(data.locked));
        setPickItems(
          data.items.map((item: any) => {
            const requestedQty = Number(item.planned_qty ?? 0);
            const availableStorageQty = Number(item.available_storage_qty ?? 0);
            const hasSavedPickQty = item.picked_qty !== null && item.picked_qty !== undefined;
            return {
              productId: item.product_id,
              productName: item.product_name,
              sku: item.sku ?? null,
              requestedQty,
              availableStorageQty,
              confirmedQty: hasSavedPickQty ? Number(item.picked_qty ?? 0) : Math.min(requestedQty, availableStorageQty),
              reason: "Product not available in storage",
              notes: "",
              machineItems: (item.machine_items ?? []).map((machine: any) => ({
                machineName: machine.machine_name,
                machineCode: machine.machine_code,
                plannedQty: Number(machine.planned_qty ?? 0),
                source: machine.source ?? "refill_recommendation",
              })),
            };
          }),
        );
        setProductOptions(data.productOptions ?? []);
        setExtras((data.extraItems ?? []).map((item: any) => ({
          id: crypto.randomUUID(),
          productId: item.productId,
          quantity: Number(item.quantity ?? 0),
          reason: item.reason ?? "Customer demand",
          notes: item.notes ?? "",
        })));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load pick list");
      } finally {
        setLoading(false);
      }
    };
    fetchPickList();
  }, [routeId, shouldStartRoute]);

  const handleConfirmPick = async () => {
    if (locked) {
      router.push(routeHref);
      return;
    }

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
  const addExtraProduct = () => {
    setExtras((prev) => [...prev, newExtraRow()]);
    setError("");
  };

  if (loading) {
    return <LoadingState variant="cards" cards={4} />;
  }

  if (!routeId) {
    return (
      <>
        <ErrorState
          title="Route id missing"
          body="This pick-list page was opened without a valid route id."
          action={<SecondaryButton href="/operator">Back to operator home</SecondaryButton>}
        />
      </>
    );
  }

  return (
    <>
      <div className="max-w-3xl space-y-6">
        <PageHeader title="Pick List" subtitle="Confirm what you actually take from storage before leaving." action={<SecondaryButton href={routeHref}>Cancel</SecondaryButton>} />

        {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{notice}</div> : null}
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        {pickItems.length === 0 ? (
          <EmptyState title="No pick-list items were added to this route." body="Ask an admin to add machine-level refill items before picking stock." />
        ) : (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>Instructions:</strong> This route pick list is calculated from each machine stop plan. Confirm actual picked quantities before leaving storage.
            </div>

            <div className="space-y-3">
              {pickItems.map((item) => (
                <div key={item.productId} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-semibold text-slate-900">{item.productName}</p>
                      <p className="mt-1 break-words text-xs text-slate-500">
                        SKU: {item.sku ?? "No SKU"} - Planned total: {item.requestedQty} units - Storage: {item.availableStorageQty}
                      </p>
                      <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {item.machineItems.map((machine, index) => (
                          <div key={`${machine.machineCode}-${index}`} className="flex flex-col gap-1 text-xs text-slate-600 sm:flex-row sm:justify-between">
                            <span className="min-w-0 break-words">{machine.machineName} ({machine.machineCode})</span>
                            <span className="shrink-0">{machine.plannedQty} - {machine.source === "manual_admin_assignment" ? "manual" : "recommendation"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="w-full shrink-0 sm:w-44">
                      <div className="mb-1 text-xs font-medium text-slate-500">Picked units</div>
                      <QuantityStepper
                        value={item.confirmedQty}
                        max={item.availableStorageQty}
                        onChange={(quantity) => updatePickItem(item.productId, { confirmedQty: quantity })}
                        disabled={locked}
                        inputLabel={`${item.productName} picked quantity`}
                      />
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
                <div className="min-w-0">
                  <p className="mb-1 text-xs text-slate-500">Products</p>
                  <p className="text-2xl font-bold text-slate-900">{pickItems.length}</p>
                </div>
                <div className="min-w-0">
                  <p className="mb-1 text-xs text-slate-500">Picked units</p>
                  <p className="text-2xl font-bold text-slate-900">{pickItems.reduce((sum, item) => sum + item.confirmedQty, 0)}</p>
                </div>
              </div>
            </SectionCard>

            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900">Operator adjustments before leaving storage</h2>
                  <p className="text-sm text-slate-500">Added products are included in the route pickup and carried inventory.</p>
                </div>
                <div className="grid gap-2 sm:flex">
                  <button type="button" className="btn-secondary w-full" onClick={addExtraProduct} disabled={locked}>Add Product</button>
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
                    disabled={locked}
                    onChange={(patch) => setExtras((prev) => prev.map((row) => row.id === item.id ? { ...row, ...patch } : row))}
                    onRemove={() => setExtras((prev) => prev.filter((row) => row.id !== item.id))}
                  />
                ))}
                {!extras.length ? <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No added products.</p> : null}
              </div>
            </section>

            <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
              <button type="button" onClick={handleConfirmPick} disabled={submitting} className="btn-primary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50">
                {locked ? "Back to Route" : submitting ? "Saving..." : alreadyConfirmed ? "Save Pickup Changes" : "Confirm Pick List"}
              </button>
              <SecondaryButton href={routeHref} type="button">Cancel</SecondaryButton>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function AdjustmentRow({
  products,
  label,
  productId,
  quantity,
  reason,
  notes,
  disabled = false,
  onChange,
  onRemove,
}: {
  products: ProductOption[];
  label: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
  disabled?: boolean;
  onChange: (patch: Partial<ExtraPickItem>) => void;
  onRemove: () => void;
}) {
  const selected = products.find((product) => product.id === productId);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_140px_1fr]">
        <ProductCombobox products={products} label={label} productId={productId} disabled={disabled} onChange={(nextProductId) => onChange({ productId: nextProductId, quantity: 0 })} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Qty</span>
          <QuantityStepper
            value={quantity}
            max={selected?.availableStorageQty ?? 0}
            onChange={(nextQuantity) => onChange({ quantity: nextQuantity })}
            disabled={disabled || !productId}
            inputLabel={`${label} quantity`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
          <select value={reason} onChange={(event) => onChange({ reason: event.target.value })} className="field-input" disabled={disabled}>
            <option>Product not available in storage</option>
            <option>Product expired/damaged</option>
            <option>Customer demand</option>
            <option>Other</option>
          </select>
        </label>
      </div>
      <input value={notes} onChange={(event) => onChange({ notes: event.target.value })} className="field-input mt-3" placeholder="Notes" disabled={disabled} />
      <button type="button" onClick={onRemove} className="mt-2 text-sm font-medium text-rose-700" disabled={disabled}>Remove</button>
    </div>
  );
}

function ProductCombobox({
  products,
  label,
  productId,
  disabled = false,
  onChange,
}: {
  products: ProductOption[];
  label: string;
  productId: string;
  disabled?: boolean;
  onChange: (productId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === productId);
  const filtered = products
    .filter((product) => !query.trim() || [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query.trim().toLowerCase())))
    .slice(0, 8);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-12 w-full rounded-md border-0 px-2 py-2 text-base outline-none ring-0 disabled:bg-slate-50 md:text-sm"
          placeholder={selected ? `${selected.name} - ${selected.sku ?? "No SKU"}` : "Search name, SKU, barcode, category, brand"}
          disabled={disabled}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              Selected: {selected.name} - Storage {selected.availableStorageQty}
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
              disabled={disabled}
              className={`min-h-14 w-full rounded-md px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${product.id === productId ? "brand-selected" : "hover:bg-slate-100"}`}
            >
              <span className="flex items-center gap-3">
                <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{product.name}</span>
                  <span className={`block truncate ${product.id === productId ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - Storage {product.availableStorageQty}</span>
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
