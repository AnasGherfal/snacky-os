import Link from "next/link";
import { ClipboardList, PackagePlus, Search, SlidersHorizontal } from "lucide-react";
import { ShoppingListButton } from "@/components/ShoppingListButton";
import {
  DataTable,
  EmptyState,
  ErrorState,
  MobileCardList,
  MobileField,
  MobileRecordCard,
  PageHeader,
  PrimaryButton,
  SearchInput,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { lyd } from "@/lib/format";
import { filterRestockItems, restockCounts, type RestockFilter, type RestockPriorityItem } from "@/lib/restock-priority";
import { loadRestockPriorityData } from "@/lib/restock-priority-data";
import { updateRestockSettings } from "@/lib/restock-priority-actions";

export const dynamic = "force-dynamic";

const filters: { key: RestockFilter; label: string }[] = [
  { key: "focus", label: "Critical + Important" },
  { key: "critical", label: "Critical only" },
  { key: "low", label: "Low only" },
  { key: "fast", label: "Fast sellers" },
  { key: "routes", label: "Needed for routes" },
  { key: "machines", label: "Needed for machines" },
  { key: "drinks", label: "Drinks" },
  { key: "snacks", label: "Snacks" },
  { key: "all", label: "All" },
];

function hrefFor(filter: RestockFilter, q: string) {
  const params = new URLSearchParams();
  if (filter !== "focus") params.set("filter", filter);
  if (q.trim()) params.set("q", q.trim());
  const query = params.toString();
  return query ? `/restock-priority?${query}` : "/restock-priority";
}

function sectionTitle(section: RestockPriorityItem["section"]) {
  if (section === "critical") return "Critical products";
  if (section === "important") return "Important products";
  return "Normal products";
}

function statusLabel(status: RestockPriorityItem["status"]) {
  if (status === "out") return "Out";
  if (status === "critical") return "Critical";
  if (status === "low") return "Low";
  return "OK";
}

function formatQty(value: number) {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

function formatVelocity(value: number) {
  return value > 0 ? `${value.toFixed(1)}/day` : "-";
}

function returnTo(filter: RestockFilter, q: string) {
  return hrefFor(filter, q);
}

function ThresholdForm({ item, currentPath }: { item: RestockPriorityItem; currentPath: string }) {
  return (
    <form action={updateRestockSettings} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <input type="hidden" name="product_id" value={item.productId} />
      <input type="hidden" name="return_to" value={currentPath} />
      <label className="text-xs font-semibold text-slate-600">
        Priority
        <select name="restock_priority" defaultValue={item.manualPriority} className="field-input mt-1">
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-600">
        Minimum
        <input name="min_storage_qty" type="number" min="0" defaultValue={item.minStorageQty} className="field-input mt-1" />
      </label>
      <label className="text-xs font-semibold text-slate-600">
        Target
        <input name="target_storage_qty" type="number" min="0" defaultValue={item.targetStorageQty} className="field-input mt-1" />
      </label>
      <label className="text-xs font-semibold text-slate-600">
        Reorder point
        <input name="reorder_point" type="number" min="0" defaultValue={item.reorderPoint} className="field-input mt-1" />
      </label>
      <label className="text-xs font-semibold text-slate-600">
        Reorder qty
        <input name="reorder_qty" type="number" min="0" defaultValue={item.reorderQty} className="field-input mt-1" />
      </label>
      <button className="btn-secondary gap-2 sm:col-span-2 lg:col-span-5" type="submit">
        <SlidersHorizontal className="h-4 w-4" />
        Save restock settings
      </button>
    </form>
  );
}

function ProductActions({ item }: { item: RestockPriorityItem }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href={`/products/${item.productId}/history`} className="btn-secondary">
        Open product
      </Link>
      <Link href={`/inventory/movements/new?product_id=${item.productId}`} className="btn-secondary">
        Storage adjustment
      </Link>
      <ShoppingListButton productId={item.productId} name={item.name} suggestedQty={item.suggestedBuyQty} />
    </div>
  );
}

function MachineNeeds({ item }: { item: RestockPriorityItem }) {
  const names = item.machinesNeedingNames.length ? item.machinesNeedingNames : item.machineNames;
  if (!names.length) return <span>-</span>;
  return (
    <details>
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">
        {item.machinesNeedingCount || item.machinesUsingCount} machine{(item.machinesNeedingCount || item.machinesUsingCount) === 1 ? "" : "s"}
      </summary>
      <div className="mt-2 flex flex-wrap gap-1">
        {names.slice(0, 12).map((name) => (
          <span key={name} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
            {name}
          </span>
        ))}
      </div>
    </details>
  );
}

function ProductCard({ item, currentPath, canEditProducts }: { item: RestockPriorityItem; currentPath: string; canEditProducts: boolean }) {
  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-950">{item.name}</div>
          <div className="mt-1 text-xs text-slate-500">{item.sku ?? "-"} · Score {item.priorityScore}</div>
        </div>
        <StatusBadge status={statusLabel(item.status)} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MobileField label="Storage">{formatQty(item.storageQty)}</MobileField>
        <MobileField label="Minimum">{item.minStorageQty}</MobileField>
        <MobileField label="Buy qty">{item.suggestedBuyQty}</MobileField>
        <MobileField label="Velocity">{formatVelocity(item.salesVelocity)}</MobileField>
        <MobileField label="Machines"><MachineNeeds item={item} /></MobileField>
        <MobileField label="Last cost">{item.lastPurchaseCost === null ? "-" : lyd(item.lastPurchaseCost)}</MobileField>
      </div>
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase text-slate-500">Why it is here</div>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {item.reasons.slice(0, 4).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      <div className="mt-4">
        <ProductActions item={item} />
      </div>
      {canEditProducts ? (
        <details className="mt-4 rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">Adjust min / target</summary>
          <ThresholdForm item={item} currentPath={currentPath} />
        </details>
      ) : null}
    </MobileRecordCard>
  );
}

function ProductTable({ items, currentPath, canEditProducts }: { items: RestockPriorityItem[]; currentPath: string; canEditProducts: boolean }) {
  return (
    <DataTable
      className="hidden md:block"
      headers={["Product", "Status", "Storage", "Min", "Buy", "Velocity", "Machines", "Last purchase", "Score", "Actions"]}
    >
      {items.map((item) => (
        <tr key={item.productId}>
          <td>
            <div className="font-semibold text-slate-900">{item.name}</div>
            <div className="text-xs text-slate-500">{item.sku ?? "-"} · {item.category ?? "-"}</div>
            <div className="mt-2 text-xs text-slate-500">{item.reasons.slice(0, 2).join(" · ")}</div>
          </td>
          <td><StatusBadge status={statusLabel(item.status)} /></td>
          <td>{formatQty(item.storageQty)}</td>
          <td>{item.minStorageQty}</td>
          <td className="font-semibold">{item.suggestedBuyQty}</td>
          <td>{formatVelocity(item.salesVelocity)}</td>
          <td><MachineNeeds item={item} /></td>
          <td>
            <div>{item.lastPurchaseCost === null ? "-" : lyd(item.lastPurchaseCost)}</div>
            <div className="text-xs text-slate-500">{item.lastPurchasedDate ?? "-"}</div>
          </td>
          <td>{item.priorityScore}</td>
          <td>
            <div className="space-y-2">
              <ProductActions item={item} />
              {canEditProducts ? (
                <details className="rounded-lg border border-slate-200 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">Adjust</summary>
                  <ThresholdForm item={item} currentPath={currentPath} />
                </details>
              ) : null}
            </div>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

function ProductSection({ title, items, currentPath, canEditProducts }: { title: string; items: RestockPriorityItem[]; currentPath: string; canEditProducts: boolean }) {
  if (!items.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        <span className="text-sm font-medium text-slate-500">{items.length} product{items.length === 1 ? "" : "s"}</span>
      </div>
      <MobileCardList>
        {items.map((item) => (
          <ProductCard key={item.productId} item={item} currentPath={currentPath} canEditProducts={canEditProducts} />
        ))}
      </MobileCardList>
      <ProductTable items={items} currentPath={currentPath} canEditProducts={canEditProducts} />
    </section>
  );
}

export default async function RestockPriorityPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; error?: string; updated?: string }>;
}) {
  const profile = await requireCurrentProfileForPath("/restock-priority");
  const canEditProducts = hasPermission(profile, "products.edit");
  const params = await searchParams;
  const filter = filters.some((item) => item.key === params.filter) ? (params.filter as RestockFilter) : "focus";
  const q = String(params.q ?? "");
  const currentPath = returnTo(filter, q);
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) {
    return <ErrorState title="Restock Priority unavailable" body="Supabase is not configured, so Snacky OS cannot calculate restock priorities." />;
  }

  const result = await loadRestockPriorityData(supabase);
  const filteredItems = filterRestockItems(result.items, filter, q);
  const counts = restockCounts(result.items);
  const sections = {
    critical: filteredItems.filter((item) => item.section === "critical"),
    important: filteredItems.filter((item) => item.section === "important"),
    normal: filteredItems.filter((item) => item.section === "normal"),
  };
  const dataWarnings = Object.entries(result.errors).filter(([key]) => key !== "products");

  return (
    <>
      <PageHeader
        title="Restock Priority"
        subtitle="Products ranked by storage thresholds, route needs, machine stock, VMS sales velocity, and manual priority."
        action={
          <div className="flex flex-wrap gap-2">
            <PrimaryButton href="/purchases/new?source=restock">
              <PackagePlus className="mr-2 h-4 w-4" />
              Create purchase list
            </PrimaryButton>
            <SecondaryButton href="/inventory/movements/new">
              <ClipboardList className="mr-2 h-4 w-4" />
              Storage adjustment
            </SecondaryButton>
          </div>
        }
      />

      {params.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.updated ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{params.updated}</div> : null}
      {result.errors.products ? (
        <ErrorState title="Could not load products" body={result.errors.products} action={<SecondaryButton href="/restock-priority">Retry</SecondaryButton>} />
      ) : (
        <>
          {dataWarnings.length ? (
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <div className="font-semibold">Restock priority partially loaded</div>
              <p className="mt-1">Working data sources are still shown. Missing VMS or route data only removes that signal from the score.</p>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                {dataWarnings.map(([key, message]) => (
                  <li key={key}>{key}: {message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="surface-card">
              <div className="text-xs font-semibold uppercase text-slate-500">Critical</div>
              <div className="mt-2 text-3xl font-semibold text-rose-700">{counts.critical}</div>
            </div>
            <div className="surface-card">
              <div className="text-xs font-semibold uppercase text-slate-500">Low</div>
              <div className="mt-2 text-3xl font-semibold text-amber-700">{counts.low}</div>
            </div>
            <div className="surface-card">
              <div className="text-xs font-semibold uppercase text-slate-500">Important</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{counts.important}</div>
            </div>
            <div className="surface-card">
              <div className="text-xs font-semibold uppercase text-slate-500">Products scanned</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900">{result.productCount}</div>
            </div>
          </div>

          <div className="mb-5 space-y-3">
            <form className="flex flex-wrap gap-2">
              <input type="hidden" name="filter" value={filter === "focus" ? "" : filter} />
              <SearchInput defaultValue={q} placeholder="Search product..." />
              <button className="btn-secondary gap-2" type="submit">
                <Search className="h-4 w-4" />
                Search
              </button>
            </form>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {filters.map((item) => (
                <Link key={item.key} href={hrefFor(item.key, q)} className={`${filter === item.key ? "btn-primary" : "btn-secondary"} shrink-0`}>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {!result.items.length ? (
            <EmptyState title="No products yet" body="Create or import products, then set storage thresholds to calculate restock priority." action={<SecondaryButton href="/products">Open products</SecondaryButton>} />
          ) : !filteredItems.length ? (
            <EmptyState title="No products match this filter" body="Try Critical + Important or clear the search." action={<SecondaryButton href="/restock-priority">Reset filters</SecondaryButton>} />
          ) : (
            <div className="space-y-8">
              <ProductSection title={sectionTitle("critical")} items={sections.critical} currentPath={currentPath} canEditProducts={canEditProducts} />
              <ProductSection title={sectionTitle("important")} items={sections.important} currentPath={currentPath} canEditProducts={canEditProducts} />
              {sections.normal.length ? (
                <details className="rounded-lg border border-slate-200 bg-white p-4">
                  <summary className="cursor-pointer text-lg font-semibold text-slate-950">
                    Normal products ({sections.normal.length})
                  </summary>
                  <div className="mt-4">
                    <ProductSection title={sectionTitle("normal")} items={sections.normal} currentPath={currentPath} canEditProducts={canEditProducts} />
                  </div>
                </details>
              ) : null}
            </div>
          )}

          {!canEditProducts ? (
            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              You can view priority, but your role cannot edit product restock thresholds.
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
