"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useLanguage } from "@/components/I18nProvider";
import { confirmPickupDirect } from "@/lib/direct-pickup-actions";
import { startRoute } from "@/lib/operator-actions";

const UNASSIGNED = "__unassigned__";
const LEGACY_CHECKLIST_KEY = "snacky:route-pickup-checklist";

type StopItem = {
  id: string;
  stopId: string | null;
  machineId: string | null;
  productId: string;
  name: string;
  sku: string | null;
  planned: number;
  available: number;
  quantity: number;
  reason: string;
  notes: string;
};

type StopGroup = {
  id: string;
  machineId: string | null;
  machine: string;
  code: string;
  location: string;
  order: number;
  items: StopItem[];
};

type Product = {
  id: string;
  name: string;
  sku: string | null;
  imageUrl: string | null;
  available: number;
};

type Extra = {
  id: string;
  stopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
};

const text = (value: unknown, fallback = "") => {
  const result = value === null || value === undefined ? "" : String(value).trim();
  return result || fallback;
};
const qty = (value: unknown) => Math.max(0, Number(value ?? 0) || 0);

function newExtra(): Extra {
  return { id: crypto.randomUUID(), stopId: UNASSIGNED, productId: "", quantity: 1, reason: "Customer demand", notes: "" };
}

export default function DirectPickupPage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[] }>();
  const searchParams = useSearchParams();
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const rawId = params?.id;
  const routeId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";
  const submissionId = useRef(crypto.randomUUID());
  const startAttempted = useRef(false);

  const [groups, setGroups] = useState<StopGroup[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const c = ar
    ? {
        title: "استلام منتجات المسار",
        subtitle: "راجع الكميات ثم أكّد الاستلام مباشرة — تم إلغاء خطوة تجهيز المنتجات.",
        back: "العودة للمسار",
        loading: "جارٍ تحميل قائمة الاستلام…",
        stops: "المحطات",
        all: "تحديد الكل",
        none: "إلغاء الكل",
        planned: "المطلوب",
        available: "المتوفر",
        pickup: "الاستلام",
        reason: "سبب اختلاف الكمية",
        notes: "ملاحظات",
        extras: "منتجات إضافية",
        add: "إضافة منتج",
        product: "المنتج",
        destination: "المحطة",
        unassigned: "غير مخصص لمحطة",
        remove: "حذف",
        summary: "ملخص الاستلام",
        units: "وحدة",
        confirm: "تأكيد الاستلام",
        confirming: "جارٍ التأكيد…",
        direct: "لا يوجد زر تجهيز. التأكيد يفحص المخزون الفعلي ثم يسجل حركة المنتجات مباشرة.",
        chooseStop: "اختر محطة واحدة على الأقل.",
        chooseProduct: "اختر المنتج في كل سطر إضافي أو احذف السطر.",
        locked: "هذا المسار مقفل ولا يمكن تعديل الاستلام.",
        done: "تم تأكيد استلام هذا المسار مسبقًا.",
        noItems: "لا توجد منتجات مطلوبة للاستلام.",
        stock: "الكمية المختارة أعلى من المخزون الظاهر؛ سيتم التحقق من المخزون مرة أخرى عند التأكيد.",
        retry: "إعادة المحاولة",
      }
    : {
        title: "Route pickup",
        subtitle: "Review quantities and confirm directly — the Prepare items step has been removed.",
        back: "Back to route",
        loading: "Loading pickup list…",
        stops: "Stops",
        all: "Select all",
        none: "Clear all",
        planned: "Planned",
        available: "Available",
        pickup: "Pickup",
        reason: "Reason for quantity change",
        notes: "Notes",
        extras: "Extra products",
        add: "Add product",
        product: "Product",
        destination: "Stop",
        unassigned: "Not assigned to a stop",
        remove: "Remove",
        summary: "Pickup summary",
        units: "units",
        confirm: "Confirm pickup",
        confirming: "Confirming…",
        direct: "There is no Prepare button. Confirm validates real stock and records the inventory movement directly.",
        chooseStop: "Select at least one stop.",
        chooseProduct: "Choose a product for every extra row or remove the empty row.",
        locked: "This route is locked and pickup cannot be edited.",
        done: "Pickup for this route has already been confirmed.",
        noItems: "There are no products to pick up.",
        stock: "Selected quantity is above visible stock; stock will be validated again on confirmation.",
        retry: "Retry",
      };

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedGroups = useMemo(() => groups.filter((group) => selected.has(group.id)), [groups, selected]);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const totalUnits = useMemo(
    () =>
      selectedGroups.flatMap((group) => group.items).reduce((sum, item) => sum + item.quantity, 0) +
      extras.reduce((sum, item) => sum + (item.productId ? item.quantity : 0), 0),
    [selectedGroups, extras],
  );

  const load = useCallback(async () => {
    if (!routeId) {
      setError("Route id is missing.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (searchParams.get("start") === "1" && !startAttempted.current) {
        startAttempted.current = true;
        const result = await startRoute(routeId);
        if (!result.success) throw new Error(result.error || "Could not start route.");
        setNotice(ar ? "تم بدء المسار." : "Route started.");
      }

      const response = await fetch(`/api/operator/routes/${routeId}/pick-list`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not load pickup list.");

      const nextGroups: StopGroup[] = (Array.isArray(data?.stopGroups) ? data.stopGroups : [])
        .map((group: any) => {
          const id = text(group?.route_stop_id);
          const machineId = text(group?.machine_id) || null;
          const items: StopItem[] = (Array.isArray(group?.items) ? group.items : [])
            .map((item: any) => {
              const itemId = text(item?.route_stop_item_id);
              const productId = text(item?.product_id);
              if (!itemId || !productId) return null;
              const planned = qty(item?.planned_qty);
              const available = qty(item?.available_storage_qty);
              const saved = item?.picked_qty !== null && item?.picked_qty !== undefined;
              return {
                id: itemId,
                stopId: text(item?.route_stop_id) || id || null,
                machineId: text(item?.machine_id) || machineId,
                productId,
                name: text(item?.product_name, ar ? "منتج غير معروف" : "Unknown product"),
                sku: text(item?.sku) || null,
                planned,
                available,
                quantity: saved ? qty(item?.picked_qty) : Math.min(planned, available),
                reason: text(item?.reason, "Product not available in storage"),
                notes: text(item?.notes),
              } as StopItem;
            })
            .filter(Boolean) as StopItem[];
          return {
            id,
            machineId,
            machine: text(group?.machine_name, ar ? "ماكينة غير معروفة" : "Unknown machine"),
            code: text(group?.machine_code, "-"),
            location: text(group?.location_name, ar ? "موقع غير معروف" : "Unknown location"),
            order: Number(group?.stop_order ?? 0),
            items,
          };
        })
        .filter((group: StopGroup) => group.id && group.items.length)
        .sort((a: StopGroup, b: StopGroup) => a.order - b.order);

      const nextProducts: Product[] = (Array.isArray(data?.productOptions) ? data.productOptions : [])
        .map((product: any) => ({
          id: text(product?.id),
          name: text(product?.name, ar ? "منتج غير معروف" : "Unknown product"),
          sku: text(product?.sku) || null,
          imageUrl: text(product?.imageUrl) || null,
          available: qty(product?.availableStorageQty),
        }))
        .filter((product: Product) => product.id);

      const nextExtras: Extra[] = (Array.isArray(data?.extraItems) ? data.extraItems : [])
        .map((item: any) => ({
          id: crypto.randomUUID(),
          stopId: text(item?.routeStopId ?? item?.route_stop_id) || UNASSIGNED,
          productId: text(item?.productId ?? item?.product_id),
          quantity: qty(item?.quantity),
          reason: text(item?.reason, "Customer demand"),
          notes: text(item?.notes),
        }))
        .filter((item: Extra) => item.productId || item.quantity > 0);

      setGroups(nextGroups);
      setSelectedIds(nextGroups.map((group) => group.id));
      setProducts(nextProducts);
      setExtras(nextExtras);
      setLocked(Boolean(data?.locked));
      setConfirmed(Boolean(data?.confirmed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load pickup list.");
    } finally {
      setLoading(false);
    }
  }, [ar, routeId, searchParams]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!routeId || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(`${LEGACY_CHECKLIST_KEY}:${routeId}`);
    } catch {
      // The removed checklist was only a browser UX helper.
    }
  }, [routeId]);

  const updateItem = (id: string, patch: Partial<StopItem>) =>
    setGroups((current) => current.map((group) => ({ ...group, items: group.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) })));
  const updateExtra = (id: string, patch: Partial<Extra>) =>
    setExtras((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const toggleStop = (id: string, checked: boolean) =>
    setSelectedIds((current) => (checked ? Array.from(new Set([...current, id])) : current.filter((value) => value !== id)));

  async function confirm() {
    setError("");
    if (locked || confirmed) return;
    if (!selectedIds.length) return setError(c.chooseStop);
    if (extras.some((item) => item.quantity > 0 && !item.productId)) return setError(c.chooseProduct);

    const pickedItems = selectedGroups.flatMap((group) =>
      group.items.map((item) => ({
        routeStopItemId: item.id,
        routeStopId: item.stopId ?? group.id,
        machineId: item.machineId ?? group.machineId,
        productId: item.productId,
        quantity: item.quantity,
        plannedQty: item.planned,
        reason: item.quantity !== item.planned ? item.reason || "Other" : undefined,
        notes: item.notes || undefined,
      })),
    );
    const extraPayload = extras
      .filter((item) => item.productId && item.quantity > 0)
      .map((item) => {
        const stopId = item.stopId === UNASSIGNED ? null : item.stopId;
        const stop = stopId ? groups.find((group) => group.id === stopId) : null;
        return {
          routeStopId: stopId,
          machineId: stop?.machineId ?? null,
          productId: item.productId,
          quantity: item.quantity,
          reason: item.reason || "Customer demand",
          notes: item.notes || undefined,
        };
      });

    setSubmitting(true);
    try {
      const result = await confirmPickupDirect(routeId, pickedItems, extraPayload, {
        stopIds: selectedIds,
        clientSubmissionId: submissionId.current,
      });
      if (!result.success) throw new Error(result.error || "Could not confirm pickup.");
      submissionId.current = crypto.randomUUID();
      router.push(`/operator/routes/${routeId}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm pickup.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="mx-auto max-w-5xl p-5 text-sm text-slate-600">{c.loading}</div>;

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 pb-28 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-950">{c.title}</h1>
          <p className="mt-1 text-sm text-slate-600">{c.subtitle}</p>
        </div>
        <button className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold" onClick={() => router.push(`/operator/routes/${routeId}`)}>{c.back}</button>
      </header>

      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold">{error}</div>
          <button className="mt-2 underline" onClick={() => void load()}>{c.retry}</button>
        </div>
      ) : null}
      {locked ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{c.locked}</div> : null}
      {confirmed ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{c.done}</div> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{c.stops}</h2>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-40" disabled={locked || confirmed} onClick={() => setSelectedIds(groups.map((group) => group.id))}>{c.all}</button>
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-40" disabled={locked || confirmed} onClick={() => setSelectedIds([])}>{c.none}</button>
          </div>
        </div>
        {groups.length ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {groups.map((group) => (
              <label key={group.id} className="flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3">
                <input type="checkbox" className="mt-1 h-5 w-5" checked={selected.has(group.id)} disabled={locked || confirmed} onChange={(event) => toggleStop(group.id, event.target.checked)} />
                <span className="min-w-0"><b className="block text-slate-900">{group.location}</b><span className="text-sm text-slate-600">{group.machine}{group.code !== "-" ? ` · ${group.code}` : ""}</span></span>
              </label>
            ))}
          </div>
        ) : <p className="mt-3 text-sm text-slate-600">{c.noItems}</p>}
      </section>

      {selectedGroups.map((group) => (
        <section key={group.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><h2 className="font-bold">{group.location}</h2><p className="text-sm text-slate-600">{group.machine}{group.code !== "-" ? ` · ${group.code}` : ""}</p></div>
          <div className="divide-y divide-slate-100">
            {group.items.map((item) => {
              const product = productById.get(item.productId);
              const adjusted = item.quantity !== item.planned;
              return (
                <div key={item.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <ProductThumbnail imageUrl={product?.imageUrl} name={item.name} size="md" />
                    <div className="min-w-0 flex-1"><div className="font-semibold text-slate-950">{item.name}</div><div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600"><span>{c.planned}: <b>{item.planned}</b></span><span>{c.available}: <b>{item.available}</b></span>{item.sku ? <span>SKU: {item.sku}</span> : null}</div></div>
                    <div className="w-36 max-w-[44%]"><div className="mb-1 text-xs font-semibold">{c.pickup}</div><QuantityStepper value={item.quantity} min={0} disabled={locked || confirmed || submitting} onChange={(value) => updateItem(item.id, { quantity: value })} inputLabel={item.name} /></div>
                  </div>
                  {item.quantity > item.available ? <p className="mt-2 text-xs font-medium text-amber-700">{c.stock}</p> : null}
                  {adjusted ? (
                    <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                      <label><span className="mb-1 block text-xs font-semibold">{c.reason}</span><select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.reason} disabled={locked || confirmed || submitting} onChange={(event) => updateItem(item.id, { reason: event.target.value })}><option>Product not available in storage</option><option>Product not in operator bag</option><option>Product expired/damaged</option><option>Customer demand</option><option>Other</option></select></label>
                      <label><span className="mb-1 block text-xs font-semibold">{c.notes}</span><input className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.notes} disabled={locked || confirmed || submitting} onChange={(event) => updateItem(item.id, { notes: event.target.value })} /></label>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">{c.extras}</h2><button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40" disabled={locked || confirmed || submitting} onClick={() => setExtras((current) => [...current, newExtra()])}>+ {c.add}</button></div>
        <div className="mt-3 space-y-3">
          {extras.map((item) => (
            <div key={item.id} className="rounded-xl border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label><span className="mb-1 block text-xs font-semibold">{c.product}</span><select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.productId} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { productId: event.target.value })}><option value="">—</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ""}</option>)}</select>{item.productId ? <span className="mt-1 block text-xs text-slate-500">{c.available}: {productById.get(item.productId)?.available ?? 0}</span> : null}</label>
                <label><span className="mb-1 block text-xs font-semibold">{c.destination}</span><select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.stopId} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { stopId: event.target.value })}><option value={UNASSIGNED}>{c.unassigned}</option>{selectedGroups.map((group) => <option key={group.id} value={group.id}>{group.location} · {group.machine}</option>)}</select></label>
                <label><span className="mb-1 block text-xs font-semibold">{c.pickup}</span><QuantityStepper value={item.quantity} min={0} disabled={locked || confirmed || submitting} onChange={(value) => updateExtra(item.id, { quantity: value })} inputLabel={c.pickup} /></label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="mb-1 block text-xs font-semibold">{c.reason}</span><select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.reason} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { reason: event.target.value })}><option>Customer demand</option><option>Product not available in storage</option><option>Product expired/damaged</option><option>Other</option></select></label><label><span className="mb-1 block text-xs font-semibold">{c.notes}</span><input className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.notes} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { notes: event.target.value })} /></label></div>
              <button type="button" className="mt-3 text-sm font-semibold text-red-700 disabled:opacity-40" disabled={locked || confirmed || submitting} onClick={() => setExtras((current) => current.filter((row) => row.id !== item.id))}>{c.remove}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-slate-950 p-4 text-white"><h2 className="font-bold">{c.summary}</h2><p className="mt-1 text-sm text-slate-300">{selectedIds.length} {c.stops} · {totalUnits} {c.units}</p><p className="mt-2 text-xs text-slate-300">{c.direct}</p></section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 p-3 backdrop-blur"><div className="mx-auto flex max-w-5xl items-center gap-3"><div className="hidden flex-1 sm:block"><div className="text-sm font-semibold">{selectedIds.length} {c.stops} · {totalUnits} {c.units}</div><div className="text-xs text-slate-500">{c.direct}</div></div><button type="button" className="min-h-12 w-full rounded-xl bg-emerald-600 px-6 py-3 font-bold text-white disabled:bg-slate-300 sm:w-auto" disabled={submitting || locked || confirmed || !selectedIds.length || !groups.length} onClick={() => void confirm()}>{submitting ? c.confirming : c.confirm}</button></div></div>
    </main>
  );
}
