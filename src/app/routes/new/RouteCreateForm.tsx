"use client";

import { FormEvent, KeyboardEvent, useDeferredValue, useMemo, useState } from "react";
import { ProductThumbnail } from "@/components/ProductThumbnail";
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

type ProductPickOption = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  storageQty: number;
  availableQty: number;
};

type PlannedStock = {
  productId: string;
  quantity: number;
  available: number;
  recommendationQty: number;
  manualQty: number;
};

type ManualStopItem = {
  machineId: string;
  productId: string;
  quantity: number;
};

export function RouteCreateForm({
  operators,
  machines,
  recommendations,
  products,
  recentProductIds,
  allowAdminOverride,
  defaultRouteDate,
}: {
  operators: Operator[];
  machines: Machine[];
  recommendations: Recommendation[];
  storageInventory: { product_id: string; product_name: string; quantity_on_hand: number }[];
  products: ProductPickOption[];
  recentProductIds: string[];
  allowAdminOverride: boolean;
  defaultRouteDate: string;
}) {
  const router = useRouter();
  const [routeDate, setRouteDate] = useState(defaultRouteDate);
  const [operatorId, setOperatorId] = useState("");
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [machineSlotIds, setMachineSlotIds] = useState<string[]>([]);
  const [manualStopItems, setManualStopItems] = useState<ManualStopItem[]>([]);
  const [manualMachineId, setManualMachineId] = useState("");
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [adminOverride, setAdminOverride] = useState(false);
  const [notFoundQuery, setNotFoundQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const recommendationQtyByProduct = useMemo(() => {
    const quantities = new Map<string, number>();
    recommendations
      .filter((row) => machineSlotIds.includes(row.machine_slot_id))
      .forEach((row) => {
        const quantity = Number(row.final_qty_to_take ?? row.suggested_qty ?? 0);
        quantities.set(row.product_id, (quantities.get(row.product_id) ?? 0) + Math.max(0, quantity));
      });
    return quantities;
  }, [machineSlotIds, recommendations]);

  const plannedRouteStock = useMemo(() => {
    const manualQtyByProduct = new Map<string, number>();
    manualStopItems.forEach((item) => {
      manualQtyByProduct.set(item.productId, (manualQtyByProduct.get(item.productId) ?? 0) + Math.max(0, Number(item.quantity ?? 0)));
    });
    const productIds = new Set([...Array.from(recommendationQtyByProduct.keys()), ...Array.from(manualQtyByProduct.keys())]);
    return Array.from(productIds)
      .map((productId): PlannedStock => {
        const product = productsById.get(productId);
        const recommendationQty = recommendationQtyByProduct.get(productId) ?? 0;
        const manualQty = manualQtyByProduct.get(productId) ?? 0;
        return {
          productId,
          quantity: recommendationQty + manualQty,
          available: Number(product?.availableQty ?? 0),
          recommendationQty,
          manualQty,
        };
      })
      .filter((item) => item.quantity > 0);
  }, [productsById, recommendationQtyByProduct, manualStopItems]);

  const selectedProducts = useMemo(
    () =>
      plannedRouteStock.map((item) => ({
        ...item,
        product: productsById.get(item.productId),
      })),
    [plannedRouteStock, productsById],
  );

  const selectedStopCount = useMemo(() => {
    const recommendedMachines = recommendations
      .filter((row) => machineSlotIds.includes(row.machine_slot_id))
      .map((row) => row.machine_id);
    return new Set([...machineIds, ...recommendedMachines]).size;
  }, [machineIds, machineSlotIds, recommendations]);

  const recentProducts = useMemo(() => {
    const recent = recentProductIds.map((id) => productsById.get(id)).filter(Boolean) as ProductPickOption[];
    return recent.length ? recent.slice(0, 8) : products.slice(0, 8);
  }, [products, productsById, recentProductIds]);

  const searchResults = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return recentProducts;
    return products
      .filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query)))
      .slice(0, 12);
  }, [products, recentProducts, deferredSearch]);

  const toggleValue = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

  const selectedManualMachineId = manualMachineId || machineIds[0] || "";

  const setManualStopQty = (machineId: string, productId: string, quantity: number) => {
    if (!machineId) {
      setError("Choose a machine stop before adding manual refill items.");
      return;
    }

    setManualStopItems((current) => {
      const next = current.filter((item) => !(item.machineId === machineId && item.productId === productId));
      if (quantity > 0) next.push({ machineId, productId, quantity: Math.floor(quantity) });
      return next;
    });
  };

  const setDesiredManualQty = (machineId: string, productId: string, desiredManual: number) => {
    const product = productsById.get(productId);
    const maxTotal = adminOverride ? Number.MAX_SAFE_INTEGER : Number(product?.availableQty ?? 0);
    const safeTotal = Math.max(0, Math.min(Math.floor(desiredManual), maxTotal));
    setManualStopQty(machineId, productId, safeTotal);
  };

  const addProductQty = (productId: string, delta: number) => {
    const machineId = selectedManualMachineId;
    if (!machineId) {
      setError("Choose at least one machine stop before adding manual products.");
      return;
    }
    const currentQty = manualStopItems.find((item) => item.machineId === machineId && item.productId === productId)?.quantity ?? 0;
    setDesiredManualQty(machineId, productId, currentQty + delta);
  };

  const handleBarcodeSelect = () => {
    const query = barcode.trim().toLowerCase();
    if (!query) return;

    const product = products.find((item) => String(item.barcode ?? "").toLowerCase() === query || String(item.sku ?? "").toLowerCase() === query);
    if (!product) {
      setNotFoundQuery(barcode.trim());
      return;
    }

    setNotFoundQuery("");
    addProductQty(product.id, 1);
    setBarcode("");
  };

  const handleBarcodeKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleBarcodeSelect();
    }
  };

  const validate = () => {
    if (!routeDate) return "Route date is required.";
    if (!operatorId) return "Operator is required when creating an assigned route.";
    if (!plannedRouteStock.length) return "Choose products to take from storage for this route.";
    const overPicked = plannedRouteStock.find((item) => item.quantity > item.available);
    if (overPicked && !adminOverride) return "One or more selected products exceeds available storage stock.";
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
        body: JSON.stringify({ routeDate, operatorId, machineIds, machineSlotIds, manualStopItems, adminOverride }),
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

  const showMissingProduct = Boolean(notFoundQuery) || (Boolean(search.trim()) && searchResults.length === 0);

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

      <FormSection title="Manual machine refill items">
        <p className="text-sm text-slate-500">Manual products must be assigned to a machine stop. The route pick list is calculated from these stop plans plus selected recommendations.</p>

        {!products.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No products are available. Add active products before creating a route pick list.
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <FormField label="Machine stop for manual items" required>
                <select
                  value={selectedManualMachineId}
                  onChange={(event) => {
                    setManualMachineId(event.target.value);
                    setMachineIds((current) => current.includes(event.target.value) ? current : [...current, event.target.value]);
                  }}
                  className="field-input"
                  disabled={saving}
                >
                  <option value="">Choose machine</option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>{machine.name} ({machine.machine_code})</option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <FormField label="Search products">
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setNotFoundQuery("");
                  }}
                  placeholder="Search name, SKU, barcode, category, or brand"
                  className="field-input"
                  disabled={saving}
                />
              </FormField>
              <FormField label="Barcode / SKU scan">
                <div className="flex gap-2">
                  <input value={barcode} onChange={(event) => setBarcode(event.target.value)} onKeyDown={handleBarcodeKey} placeholder="Scan or type barcode" className="field-input" disabled={saving} />
                  <button type="button" onClick={handleBarcodeSelect} className="btn-secondary" disabled={saving}>
                    Add
                  </button>
                </div>
              </FormField>
            </div>

            {showMissingProduct ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <div className="font-semibold">Product not found</div>
                <p className="mt-1">Check the barcode, SKU, or product name before adding it to master data.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a className="btn-secondary" href="/products/new">
                    Add product
                  </a>
                  <a className="btn-secondary" href={`/issues?missing_product=${encodeURIComponent(notFoundQuery || search.trim())}`}>
                    Report missing product
                  </a>
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-800">{search.trim() ? "Search results" : "Recent / frequently used products"}</div>
                <div className="text-xs text-slate-500">Enter adds scanned products instantly.</div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {searchResults.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => addProductQty(product.id, 1)}
                    className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving || (!adminOverride && product.availableQty <= 0)}
                  >
                    <div className="flex gap-3">
                      <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-900">{product.name}</div>
                        <div className="text-xs text-slate-500">
                          {product.sku ?? "No SKU"} - {product.category ?? "Uncategorized"} {product.brand ? `- ${product.brand}` : ""}
                        </div>
                        <div className="mt-1 text-xs text-slate-600">
                          Storage {product.storageQty} / Available {product.availableQty}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {allowAdminOverride ? (
              <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <input type="checkbox" checked={adminOverride} onChange={(event) => setAdminOverride(event.target.checked)} className="mt-1" disabled={saving} />
                <span>
                  <span className="block font-semibold">Admin override</span>
                  Allow quantities above available storage for a supervised count correction.
                </span>
              </label>
            ) : null}

            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Available storage qty</th>
                    <th className="px-3 py-2">Manual planned qty</th>
                    <th className="px-3 py-2">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {!manualStopItems.length ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                        No manual machine refill items selected yet.
                      </td>
                    </tr>
                  ) : (
                    manualStopItems.map((item) => {
                      const product = productsById.get(item.productId);
                      const machine = machines.find((row) => row.id === item.machineId);
                      const available = Number(product?.availableQty ?? 0);
                      const exceeds = item.quantity > available;
                      return (
                        <tr key={`${item.machineId}-${item.productId}`} className="border-t border-slate-200">
                          <td className="px-3 py-2">{machine?.name ?? "Unknown machine"}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-3">
                              <ProductThumbnail imageUrl={product?.imageUrl} name={product?.name} size="md" />
                              <div>
                                <div className="font-medium text-slate-900">{product?.name ?? "Unknown product"}</div>
                                <div className="text-xs text-slate-500">{product?.sku ?? "No SKU"}</div>
                              </div>
                            </div>
                          </td>
                          <td className={`px-3 py-2 ${exceeds && !adminOverride ? "font-semibold text-rose-700" : ""}`}>{available}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {[-1, 1, 5, 10].map((delta) => (
                                <button key={delta} type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setDesiredManualQty(item.machineId, item.productId, item.quantity + delta)} disabled={saving}>
                                  {delta > 0 ? `+${delta}` : delta}
                                </button>
                              ))}
                              <input
                                type="number"
                                min={0}
                                max={adminOverride ? undefined : available}
                                value={item.quantity}
                                onChange={(event) => setDesiredManualQty(item.machineId, item.productId, Number(event.target.value) || 0)}
                                className={`field-input w-24 ${exceeds && !adminOverride ? "border-rose-300" : ""}`}
                                disabled={saving}
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => setManualStopQty(item.machineId, item.productId, 0)} className="link-secondary" disabled={saving}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title="Refill recommendation rows">
        <p className="text-sm text-slate-500">Import available refill lines when VMS stock and machine slots already produced recommendations.</p>
        {!recommendations.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No active refill recommendations found. You can still build the route manually above.
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
        <span className="mx-2 text-slate-300">/</span>
        Route pick-list products: <span className="font-semibold text-slate-900">{selectedProducts.length}</span>
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
