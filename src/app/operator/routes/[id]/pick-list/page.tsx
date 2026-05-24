"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { EmptyState, ErrorState, LoadingState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { confirmPickList, startRoute } from "@/lib/operator-actions";

const UNASSIGNED_EXTRA_TARGET = "__unassigned__";

interface PickStopItem {
  routeStopItemId: string;
  routeStopId: string | null;
  machineId: string | null;
  productId: string;
  productName: string;
  sku: string | null;
  requestedQty: number;
  availableStorageQty: number;
  confirmedQty: number;
  reason: string;
  notes: string;
  source: string;
}
interface PickStopGroup {
  routeStopId: string | null;
  machineId: string | null;
  machineName: string;
  machineCode: string;
  locationName: string;
  stopOrder: number;
  items: PickStopItem[];
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
  targetStopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}
interface RouteTotal {
  productId: string;
  productName: string;
  sku: string | null;
  plannedQty: number;
  confirmedQty: number;
  availableStorageQty: number;
}
type PickListDraft = {
  stopItems: { routeStopItemId: string; confirmedQty: number; reason: string; notes: string }[];
  extras: ExtraPickItem[];
};

function safeRouteHref(routeId: string) {
  return routeId ? `/operator/routes/${routeId}` : "/operator";
}

function newExtraRow(): ExtraPickItem {
  return { id: crypto.randomUUID(), targetStopId: "", productId: "", quantity: 0, reason: "Customer demand", notes: "" };
}

function comparablePickDraft(draft: PickListDraft) {
  return JSON.stringify({
    stopItems: [...draft.stopItems].sort((a, b) => a.routeStopItemId.localeCompare(b.routeStopItemId)),
    extras: draft.extras
      .map(({ id: _id, ...item }) => item)
      .filter((item) => item.targetStopId || item.productId || item.quantity > 0 || item.notes.trim())
      .sort((a, b) => `${a.targetStopId}:${a.productId}:${a.reason}:${a.notes}`.localeCompare(`${b.targetStopId}:${b.productId}:${b.reason}:${b.notes}`)),
  });
}

function targetStopId(routeStopId: string | null | undefined) {
  return routeStopId ? routeStopId : UNASSIGNED_EXTRA_TARGET;
}

function submittedRouteStopId(target: string) {
  if (!target || target === UNASSIGNED_EXTRA_TARGET) return null;
  return target;
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
  const [stopGroups, setStopGroups] = useState<PickStopGroup[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [extras, setExtras] = useState<ExtraPickItem[]>([]);
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const errorRef = useRef<HTMLDivElement | null>(null);
  const initialPickDraftRef = useRef<string>("");
  const draftKey = useDraftKey("route-pickup", [routeId || "missing-route"]);

  const allStopItems = useMemo(() => stopGroups.flatMap((group) => group.items), [stopGroups]);
  const productById = useMemo(() => new Map(productOptions.map((product) => [product.id, product])), [productOptions]);
  const stopById = useMemo(() => new Map(stopGroups.filter((group) => group.routeStopId).map((group) => [group.routeStopId as string, group])), [stopGroups]);
  const pickedByProduct = useMemo(() => {
    const totals = new Map<string, number>();
    allStopItems.forEach((item) => totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.confirmedQty));
    extras.forEach((item) => {
      if (item.productId && item.quantity > 0) totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
    });
    return totals;
  }, [allStopItems, extras]);
  const routeTotals = useMemo<RouteTotal[]>(() => {
    const totals = new Map<string, RouteTotal>();
    allStopItems.forEach((item) => {
      const current = totals.get(item.productId) ?? {
        productId: item.productId,
        productName: item.productName,
        sku: item.sku,
        plannedQty: 0,
        confirmedQty: 0,
        availableStorageQty: productById.get(item.productId)?.availableStorageQty ?? item.availableStorageQty,
      };
      current.plannedQty += item.requestedQty;
      current.confirmedQty += item.confirmedQty;
      current.availableStorageQty = Math.max(current.availableStorageQty, productById.get(item.productId)?.availableStorageQty ?? item.availableStorageQty);
      totals.set(item.productId, current);
    });
    extras.forEach((item) => {
      if (!item.productId || item.quantity <= 0) return;
      const product = productById.get(item.productId);
      const current = totals.get(item.productId) ?? {
        productId: item.productId,
        productName: product?.name ?? "Unknown product",
        sku: product?.sku ?? null,
        plannedQty: 0,
        confirmedQty: 0,
        availableStorageQty: product?.availableStorageQty ?? 0,
      };
      current.confirmedQty += item.quantity;
      totals.set(item.productId, current);
    });
    return Array.from(totals.values()).sort((a, b) => a.productName.localeCompare(b.productName));
  }, [allStopItems, extras, productById]);
  const totalPickedUnits = routeTotals.reduce((sum, item) => sum + item.confirmedQty, 0);
  const assignedExtraCount = extras.filter((item) => item.productId && item.quantity > 0 && submittedRouteStopId(item.targetStopId)).length;
  const unassignedExtraCount = extras.filter((item) => item.productId && item.quantity > 0 && item.targetStopId === UNASSIGNED_EXTRA_TARGET).length;

  const pickDraft = useMemo<PickListDraft>(() => ({
    stopItems: allStopItems.map((item) => ({
      routeStopItemId: item.routeStopItemId,
      confirmedQty: item.confirmedQty,
      reason: item.reason,
      notes: item.notes,
    })),
    extras,
  }), [allStopItems, extras]);
  const shouldSavePickDraft = useCallback((draft: PickListDraft) => {
    if (!routeId || locked || !initialPickDraftRef.current) return false;
    return comparablePickDraft(draft) !== initialPickDraftRef.current;
  }, [locked, routeId]);
  const localDraft = useLocalDraft<PickListDraft>({
    key: draftKey,
    value: pickDraft,
    shouldSave: shouldSavePickDraft,
    onRestore: (draft) => {
      const draftByStopItem = new Map((draft.stopItems ?? []).map((item) => [item.routeStopItemId, item]));
      setStopGroups((current) => current.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          const saved = draftByStopItem.get(item.routeStopItemId);
          return saved ? { ...item, confirmedQty: saved.confirmedQty, reason: saved.reason, notes: saved.notes } : item;
        }),
      })));
      setExtras((draft.extras ?? []).map((item) => ({ ...item, id: item.id || crypto.randomUUID(), targetStopId: item.targetStopId || "" })));
    },
  });

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
        const responseStopGroups = Array.isArray(data.stopGroups) ? data.stopGroups : [];
        const responseProductOptions = Array.isArray(data.productOptions) ? data.productOptions : [];
        const responseExtraItems = Array.isArray(data.extraItems) ? data.extraItems : [];
        const nextStopGroups = responseStopGroups.map((group: any) => ({
          routeStopId: group.route_stop_id ? String(group.route_stop_id) : null,
          machineId: group.machine_id ? String(group.machine_id) : null,
          machineName: group.machine_name || "Unknown machine",
          machineCode: group.machine_code || "-",
          locationName: group.location_name || "Unknown location",
          stopOrder: Number(group.stop_order ?? 0),
          items: (Array.isArray(group.items) ? group.items : []).map((item: any) => {
            const requestedQty = Number(item.planned_qty ?? 0);
            const availableStorageQty = Number(item.available_storage_qty ?? 0);
            const hasSavedPickQty = item.picked_qty !== null && item.picked_qty !== undefined;
            return {
              routeStopItemId: String(item.route_stop_item_id ?? ""),
              routeStopId: item.route_stop_id ? String(item.route_stop_id) : group.route_stop_id ? String(group.route_stop_id) : null,
              machineId: item.machine_id ? String(item.machine_id) : group.machine_id ? String(group.machine_id) : null,
              productId: String(item.product_id ?? ""),
              productName: item.product_name || "Unknown product",
              sku: item.sku ?? null,
              requestedQty,
              availableStorageQty,
              confirmedQty: hasSavedPickQty ? Number(item.picked_qty ?? 0) : Math.min(requestedQty, availableStorageQty),
              reason: item.reason ?? "Product not available in storage",
              notes: item.notes ?? "",
              source: item.source ?? "refill_recommendation",
            };
          }).filter((item: PickStopItem) => item.routeStopItemId && item.productId),
        })).filter((group: PickStopGroup) => group.items.length > 0);
        const nextExtras = responseExtraItems.map((item: any) => ({
          id: crypto.randomUUID(),
          targetStopId: targetStopId(item.routeStopId ?? item.route_stop_id),
          productId: String(item.productId ?? item.product_id ?? ""),
          quantity: Number(item.quantity ?? 0),
          reason: item.reason ?? "Customer demand",
          notes: item.notes ?? "",
        })).filter((item: ExtraPickItem) => item.productId || item.quantity > 0);
        setStopGroups(nextStopGroups);
        setProductOptions(responseProductOptions.map((product: any) => ({
          id: String(product.id ?? ""),
          sku: product.sku ?? null,
          barcode: product.barcode ?? null,
          name: product.name || "Unnamed product",
          category: product.category ?? null,
          brand: product.brand ?? null,
          imageUrl: product.imageUrl ?? null,
          availableStorageQty: Number(product.availableStorageQty ?? 0),
        })).filter((product: ProductOption) => product.id));
        setExtras(nextExtras);
        initialPickDraftRef.current = comparablePickDraft({
          stopItems: nextStopGroups.flatMap((group: PickStopGroup) => group.items.map((item) => ({
            routeStopItemId: item.routeStopItemId,
            confirmedQty: item.confirmedQty,
            reason: item.reason,
            notes: item.notes,
          }))),
          extras: nextExtras,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load pick list");
      } finally {
        setLoading(false);
      }
    };
    fetchPickList();
  }, [routeId, shouldStartRoute]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const maxForProduct = (productId: string, currentQty: number, fallbackAvailable: number) => {
    const available = productById.get(productId)?.availableStorageQty ?? fallbackAvailable;
    const used = pickedByProduct.get(productId) ?? 0;
    return Math.max(0, available - used + currentQty);
  };

  const updateStopItem = (routeStopItemId: string, patch: Partial<PickStopItem>) => {
    setStopGroups((prev) => prev.map((group) => ({
      ...group,
      items: group.items.map((item) => (item.routeStopItemId === routeStopItemId ? { ...item, ...patch } : item)),
    })));
  };

  const addExtraProduct = () => {
    setExtras((prev) => [...prev, newExtraRow()]);
    setError("");
  };

  const handleConfirmPick = async () => {
    if (locked) {
      router.push(routeHref);
      return;
    }

    const invalidExtra = extras.find((item) => item.productId && item.quantity > 0 && !item.targetStopId);
    if (invalidExtra) {
      setError("Choose a machine/stop for the added product, or mark it as extra carried stock.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const items = allStopItems.map((item) => ({
        routeStopItemId: item.routeStopItemId,
        routeStopId: item.routeStopId,
        machineId: item.machineId,
        productId: item.productId,
        quantity: item.confirmedQty,
        plannedQty: item.requestedQty,
        reason: item.reason,
        notes: item.notes,
      }));
      const result = await confirmPickList(
        routeId,
        items,
        extras
          .filter((item) => item.productId && item.quantity > 0)
          .map((item) => {
            const stop = submittedRouteStopId(item.targetStopId) ? stopById.get(submittedRouteStopId(item.targetStopId) as string) : null;
            return {
              routeStopId: submittedRouteStopId(item.targetStopId),
              machineId: stop?.machineId ?? null,
              productId: item.productId,
              quantity: item.quantity,
              reason: item.reason,
              notes: item.notes,
            };
          }),
      );
      if (result && "success" in result && result.success === false) {
        throw new Error(result.error || "Could not save added product");
      }
      localDraft.clearDraft();
      router.push(routeHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm pick list");
      setSubmitting(false);
    }
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
      <div className="max-w-5xl space-y-6">
        <PageHeader title="Storage Pickup" subtitle="Pack products by machine before leaving storage." action={<SecondaryButton href={routeHref}>Cancel</SecondaryButton>} />

        <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
        {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{notice}</div> : null}
        {error ? <div ref={errorRef} className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">Machine stops</p>
              <p className="text-2xl font-bold text-slate-900">{stopGroups.length}</p>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">Products</p>
              <p className="text-2xl font-bold text-slate-900">{routeTotals.length}</p>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">Picked units</p>
              <p className="text-2xl font-bold text-slate-900">{totalPickedUnits}</p>
            </div>
          </SectionCard>
        </div>

        {stopGroups.length === 0 ? (
          <EmptyState title="No planned pickup items" body="This route has no machine-level products assigned yet. You can still add active products below." />
        ) : (
          <div className="space-y-4">
            {stopGroups.map((group) => {
              const groupPlanned = group.items.reduce((sum, item) => sum + item.requestedQty, 0);
              const groupPicked = group.items.reduce((sum, item) => sum + item.confirmedQty, 0);
              return (
                <details key={group.routeStopId ?? group.machineId ?? group.machineName} open className="rounded-lg border border-slate-200 bg-white">
                  <summary className="cursor-pointer list-none border-b border-slate-200 p-4 marker:hidden">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Stop {group.stopOrder || "-"}</div>
                        <h2 className="break-words text-lg font-semibold text-slate-900">{group.machineName}</h2>
                        <p className="mt-1 break-words text-sm text-slate-500">{group.locationName} - {group.machineCode}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm sm:w-56">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div className="text-xs text-slate-500">Planned</div>
                          <div className="font-semibold text-slate-900">{groupPlanned}</div>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div className="text-xs text-slate-500">Packed</div>
                          <div className="font-semibold text-slate-900">{groupPicked}</div>
                        </div>
                      </div>
                    </div>
                  </summary>

                  <div className="divide-y divide-slate-200">
                    {group.items.map((item) => {
                      const maxQty = maxForProduct(item.productId, item.confirmedQty, item.availableStorageQty);
                      return (
                        <div key={item.routeStopItemId} className="space-y-4 p-4">
                          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_190px] md:items-start">
                            <div className="min-w-0">
                              <p className="break-words font-semibold text-slate-900">{item.productName}</p>
                              <p className="mt-1 break-words text-xs text-slate-500">
                                SKU: {item.sku ?? "No SKU"} - Recommended: {item.requestedQty} - Route storage: {item.availableStorageQty}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">{item.source === "manual_admin_assignment" ? "Manual assignment" : "Refill recommendation"}</p>
                            </div>
                            <label className="block">
                              <span className="mb-1 block text-sm font-medium text-slate-800">Pickup qty</span>
                              <QuantityStepper
                                value={item.confirmedQty}
                                max={maxQty}
                                onChange={(quantity) => updateStopItem(item.routeStopItemId, { confirmedQty: quantity })}
                                disabled={locked}
                                inputLabel={`${group.machineName} ${item.productName} pickup quantity`}
                              />
                              <span className="mt-1 block text-xs text-slate-500">Available for this row: {maxQty}</span>
                            </label>
                          </div>

                          {item.confirmedQty !== item.requestedQty ? (
                            <div className="grid gap-3 md:grid-cols-2">
                              <label className="block">
                                <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
                                <select value={item.reason} onChange={(event) => updateStopItem(item.routeStopItemId, { reason: event.target.value })} className="field-input" disabled={locked}>
                                  <option>Product not available in storage</option>
                                  <option>Product not in operator bag</option>
                                  <option>Product expired/damaged</option>
                                  <option>Customer demand</option>
                                  <option>Other</option>
                                </select>
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
                                <input value={item.notes} onChange={(event) => updateStopItem(item.routeStopItemId, { notes: event.target.value })} className="field-input" placeholder="Explain the pickup change" disabled={locked} />
                              </label>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Added products before leaving storage</h2>
              <p className="text-sm text-slate-500">{assignedExtraCount} assigned to stops, {unassignedExtraCount} carried as spare stock</p>
            </div>
            <button type="button" className="btn-secondary w-full sm:w-auto" onClick={addExtraProduct} disabled={locked}>Add Product</button>
          </div>
          <div className="mt-4 space-y-3">
            {extras.map((item) => (
              <AdjustmentRow
                key={item.id}
                products={productOptions}
                stopGroups={stopGroups}
                targetStopId={item.targetStopId}
                productId={item.productId}
                quantity={item.quantity}
                reason={item.reason}
                notes={item.notes}
                disabled={locked}
                maxQuantity={item.productId ? maxForProduct(item.productId, item.quantity, productById.get(item.productId)?.availableStorageQty ?? 0) : 0}
                onChange={(patch) => setExtras((prev) => prev.map((row) => row.id === item.id ? { ...row, ...patch } : row))}
                onRemove={() => setExtras((prev) => prev.filter((row) => row.id !== item.id))}
              />
            ))}
            {!extras.length ? <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No added products.</p> : null}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-semibold text-slate-900">Route total</h2>
          <div className="mt-3 divide-y divide-slate-200">
            {routeTotals.map((item) => (
              <div key={item.productId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="break-words font-medium text-slate-900">{item.productName}</p>
                  <p className="text-xs text-slate-500">{item.sku ?? "No SKU"} - Storage {item.availableStorageQty}</p>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {item.confirmedQty} / {item.plannedQty}
                </div>
              </div>
            ))}
            {!routeTotals.length ? <p className="py-3 text-sm text-slate-500">No route totals yet.</p> : null}
          </div>
        </section>

        <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
          {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 sm:hidden">{error}</div> : null}
          <button type="button" onClick={handleConfirmPick} disabled={submitting} className="btn-primary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50">
            {locked ? "Back to Route" : submitting ? "Saving..." : alreadyConfirmed ? "Save Pickup Changes" : "Confirm Pickup"}
          </button>
          <SecondaryButton href={routeHref} type="button">Cancel</SecondaryButton>
        </div>
      </div>
    </>
  );
}

function AdjustmentRow({
  products,
  stopGroups,
  targetStopId,
  productId,
  quantity,
  reason,
  notes,
  disabled = false,
  maxQuantity,
  onChange,
  onRemove,
}: {
  products: ProductOption[];
  stopGroups: PickStopGroup[];
  targetStopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
  disabled?: boolean;
  maxQuantity: number;
  onChange: (patch: Partial<ExtraPickItem>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_140px]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Machine / stop</span>
          <select
            value={targetStopId}
            onChange={(event) => onChange({ targetStopId: event.target.value })}
            className="field-input"
            disabled={disabled}
          >
            <option value="">Select machine/stop</option>
            {stopGroups.map((group) => (
              <option key={group.routeStopId ?? group.machineId ?? group.machineName} value={group.routeStopId ?? ""}>
                Stop {group.stopOrder || "-"} - {group.machineName} / {group.locationName}
              </option>
            ))}
            <option value={UNASSIGNED_EXTRA_TARGET}>Extra carried products / not assigned</option>
          </select>
        </label>
        <ProductCombobox products={products} label="Product" productId={productId} disabled={disabled || !targetStopId} onChange={(nextProductId) => onChange({ productId: nextProductId, quantity: 0 })} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Qty</span>
          <QuantityStepper
            value={quantity}
            max={maxQuantity}
            onChange={(nextQuantity) => onChange({ quantity: nextQuantity })}
            disabled={disabled || !productId}
            inputLabel="Added product quantity"
          />
        </label>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_2fr]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
          <select value={reason} onChange={(event) => onChange({ reason: event.target.value })} className="field-input" disabled={disabled}>
            <option>Product not available in storage</option>
            <option>Product expired/damaged</option>
            <option>Customer demand</option>
            <option>Other</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
          <input value={notes} onChange={(event) => onChange({ notes: event.target.value })} className="field-input" placeholder="Notes" disabled={disabled} />
        </label>
      </div>
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
          {filtered.map((product) => {
            const outOfStock = product.availableStorageQty <= 0 && product.id !== productId;
            return (
              <button
                key={product.id}
                type="button"
                onClick={() => {
                  if (outOfStock) return;
                  onChange(product.id);
                  setQuery("");
                }}
                disabled={disabled || outOfStock}
                className={`min-h-14 w-full rounded-md px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${product.id === productId ? "brand-selected" : "hover:bg-slate-100"}`}
              >
                <span className="flex items-center gap-3">
                  <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{product.name}</span>
                    <span className={`block truncate ${product.id === productId ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - Storage {product.availableStorageQty}{outOfStock ? " available" : ""}</span>
                  </span>
                </span>
              </button>
            );
          })}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">No products found.</p> : null}
        </div>
      </div>
    </div>
  );
}
