"use client";

import { useMemo, useState } from "react";
import { saveRouteItemEdits } from "@/lib/route-item-edit-actions";

function newClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function productLabel(product: { name: string; sku?: string | null; category?: string | null }) {
  const category = product.category ? product.category : "Uncategorized";
  const sku = product.sku ? ` - ${product.sku}` : "";
  return `${product.name} - ${category}${sku}`;
}

type RouteStopOption = {
  id: string;
  machineId: string;
  label: string;
  stopOrder: number;
};

type ProductOption = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
};

type RouteItemRow = {
  clientKey: string;
  routeStopItemId: string | null;
  routeStopId: string;
  productId: string;
  quantity: number;
  notes: string;
  source: string;
  createdAt: string | null;
  checkedAt: string | null;
  isChecked: boolean;
};

type RouteItemEditorProps = {
  routeId: string;
  routeStatus: string;
  routeStartedAt: string | null;
  readOnly: boolean;
  stops: RouteStopOption[];
  products: ProductOption[];
  initialRows: RouteItemRow[];
  warningMessage?: string | null;
};

function rowSortValue(row: RouteItemRow, productName: string) {
  return [row.quantity > 0 ? 0 : 1, productName.toLowerCase(), row.createdAt ?? "", row.clientKey].join("|");
}

export function RouteItemEditor({
  routeId,
  routeStatus,
  routeStartedAt,
  readOnly,
  stops,
  products,
  initialRows,
  warningMessage,
}: RouteItemEditorProps) {
  const [rows, setRows] = useState<RouteItemRow[]>(initialRows);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const groupedRows = useMemo(() => {
    const byStop = new Map<string, RouteItemRow[]>();
    rows.forEach((row) => {
      byStop.set(row.routeStopId, [...(byStop.get(row.routeStopId) ?? []), row]);
    });

    return stops.map((stop) => {
      const stopRows = (byStop.get(stop.id) ?? []).slice().sort((left, right) => {
        const leftName = productById.get(left.productId)?.name ?? "";
        const rightName = productById.get(right.productId)?.name ?? "";
        return rowSortValue(left, leftName).localeCompare(rowSortValue(right, rightName));
      });
      return { stop, rows: stopRows };
    });
  }, [productById, rows, stops]);

  const payload = useMemo(() => JSON.stringify({
    routeId,
    items: rows.map((row) => ({
      id: row.routeStopItemId,
      routeStopId: row.routeStopId,
      productId: row.productId,
      quantity: row.quantity,
      notes: row.notes,
    })),
  }), [routeId, rows]);

  const updateRow = (clientKey: string, patch: Partial<RouteItemRow>) => {
    setRows((current) => current.map((row) => (row.clientKey === clientKey ? { ...row, ...patch } : row)));
  };

  const addRow = (routeStopId: string) => {
    if (readOnly) return;
    setRows((current) => [
      ...current,
      {
        clientKey: newClientId(),
        routeStopItemId: null,
        routeStopId,
        productId: "",
        quantity: 1,
        notes: "",
        source: "manual_admin_assignment",
        createdAt: null,
        checkedAt: null,
        isChecked: false,
      },
    ]);
  };

  const changeQuantity = (clientKey: string, value: string) => {
    const nextQuantity = Math.max(0, Math.floor(Number(value ?? 0) || 0));
    updateRow(clientKey, { quantity: nextQuantity });
  };

  return (
    <form action={saveRouteItemEdits} className="space-y-5">
      <input type="hidden" name="id" value={routeId} />
      <input type="hidden" name="payload" value={payload} />

      {warningMessage ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {warningMessage}
        </div>
      ) : null}
      {readOnly ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          Route already started or completed. This screen is read only.
        </div>
      ) : null}

      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Route status: <span className="text-slate-900">{routeStatus}</span>
      </div>

      <div className="space-y-4">
        {groupedRows.map(({ stop, rows: stopRows }) => {
          const stopLabel = stop.label;
          return (
            <section key={stop.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">الجهاز</div>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">{stopLabel}</h2>
                  <p className="mt-1 text-sm text-slate-500">Stop {stop.stopOrder}</p>
                </div>
                {!readOnly ? (
                  <button type="button" className="btn-secondary" onClick={() => addRow(stop.id)}>
                    إضافة منتج
                  </button>
                ) : null}
              </div>

              <div className="space-y-3 p-4">
                {stopRows.length ? (
                  stopRows.map((row) => {
                    const currentProduct = productById.get(row.productId);
                    const isRemoved = row.quantity === 0;
                    const isNewAfterStart = Boolean(row.source === "manual_admin_assignment" && routeStartedAt && row.createdAt && new Date(row.createdAt).getTime() > new Date(routeStartedAt).getTime());
                    return (
                      <article key={row.clientKey} className={`rounded-2xl border p-4 ${isRemoved ? "border-rose-200 bg-rose-50/70" : "border-slate-200 bg-slate-50"}`}>
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_140px]">
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-slate-800">الجهاز</span>
                            <select
                              className="field-input"
                              value={row.routeStopId}
                              onChange={(event) => updateRow(row.clientKey, { routeStopId: event.target.value })}
                              disabled={readOnly}
                            >
                              {stops.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-slate-800">Product</span>
                            <select
                              className="field-input"
                              value={row.productId}
                              onChange={(event) => updateRow(row.clientKey, { productId: event.target.value })}
                              disabled={readOnly}
                            >
                              <option value="">Choose a product</option>
                              {products.map((product) => (
                                <option key={product.id} value={product.id}>
                                  {productLabel(product)}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-slate-800">الكمية</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              className="field-input"
                              value={row.quantity}
                              onChange={(event) => changeQuantity(row.clientKey, event.target.value)}
                              disabled={readOnly}
                            />
                          </label>
                        </div>

                        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                          <label className="block">
                            <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
                            <input
                              className="field-input"
                              value={row.notes}
                              onChange={(event) => updateRow(row.clientKey, { notes: event.target.value })}
                              disabled={readOnly}
                              placeholder="Optional note"
                            />
                          </label>

                          {!readOnly ? (
                            <div className="flex items-end">
                              <button type="button" className="btn-secondary w-full md:w-auto" onClick={() => changeQuantity(row.clientKey, "0")}>
                                إزالة
                              </button>
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
                          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-slate-700">
                            {row.source === "manual_admin_assignment" ? "Manual assignment" : "Refill recommendation"}
                          </span>
                          {isNewAfterStart ? (
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">New added item</span>
                          ) : null}
                          {isRemoved ? (
                            <span className="rounded-full bg-rose-100 px-2.5 py-1 text-rose-700">Removed</span>
                          ) : null}
                          {row.isChecked ? (
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">Picked before start</span>
                          ) : null}
                          {currentProduct ? (
                            <span className="rounded-full bg-white px-2.5 py-1 text-slate-500">
                              {currentProduct.category ? currentProduct.category : "Uncategorized"}
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                    No products assigned to this stop yet.
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {!readOnly ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" className="btn-primary">
            حفظ تعديلات الجولة
          </button>
          <a href={`/routes/${routeId}`} className="btn-secondary inline-flex items-center justify-center">
            Cancel
          </a>
        </div>
      ) : (
        <div className="flex">
          <a href={`/routes/${routeId}`} className="btn-secondary inline-flex items-center justify-center">
            Back to route
          </a>
        </div>
      )}
    </form>
  );
}
