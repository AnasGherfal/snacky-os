import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { formatMachineDisplayName, relationRecord } from "@/lib/machine-site-display";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

export const dynamic = "force-dynamic";

type MachineRow = {
  id: string;
  name: string;
  machine_code: string | null;
  location: { id: string; name: string } | { id: string; name: string }[] | null;
};

type ProductRow = {
  id: string;
  sku: string | null;
  name: string;
};

type MachineStorageRow = {
  id: string;
  machine_id: string;
  location_id: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number;
  notes: string | null;
  updated_at: string;
  created_at: string;
};

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "-";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function matchesText(values: Array<string | null | undefined>, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
}

function machineLabel(machine: any, fallbackId: string) {
  const machineCode = String(machine?.machine_code ?? "").trim();
  const name = String(machine?.name ?? "").trim();
  if (machineCode && name && machineCode !== name) return `${machineCode} - ${name}`;
  return machineCode || name || shortId(fallbackId);
}

function locationLabel(machine: any, row: MachineStorageRow) {
  const location = relationRecord(machine?.location);
  const name = String(location?.name ?? "").trim();
  return name || (row.location_id ? shortId(row.location_id) : "-");
}

function stockStatus(quantity: number) {
  if (quantity <= 0) return "out_of_stock";
  if (quantity <= 10) return "low_stock";
  return "available";
}

export default async function MachineStoragePage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const q = String(params.q ?? "").trim();
  const machineId = String(params.machine_id ?? "").trim();
  const productId = String(params.product_id ?? "").trim();

  const profile = await getCurrentProfile();
  const userContext = profile
    ? {
        id: profile.id,
        role: profile.role,
        roles: profile.roles,
        canAddProducts: profile.can_add_products,
        teamMemberId: profile.team_member_id,
        activeStatus: profile.active_status,
      }
    : null;

  if (!profile || !canAccessPath(userContext, "/inventory")) {
    redirect("/unauthorized");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <ErrorState
        title="Machine storage unavailable"
        body="Supabase is not configured, so Snacky OS cannot load machine storage projection rows."
        action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
      />
    );
  }

  const [
    { data: machines, error: machinesError },
    { data: products, error: productsError },
  ] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").order("name").limit(1000),
    supabase.from("products").select("id, sku, name").order("name").limit(1000),
  ]);

  if (machinesError || productsError) {
    console.error("[inventory:machine-storage] Failed to load machine or product filters", machinesError ?? productsError);
    return (
      <ErrorState
        title="Could not load machine storage filters"
        body="Snacky OS could not load the machine or product catalog needed for the machine storage ledger."
        action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
      />
    );
  }

  const machineRows = (machines ?? []) as MachineRow[];
  const productRows = (products ?? []) as ProductRow[];
  const machineById = new Map(machineRows.map((machine) => [machine.id, machine]));
  const productById = new Map(productRows.map((product) => [product.id, product]));

  const matchingMachineIds = q
    ? machineRows.filter((machine) => matchesText([formatMachineDisplayName(machine, { includeArea: true }), machine.name, machine.machine_code, relationRecord(machine.location)?.name], q)).map((machine) => machine.id)
    : [];
  const matchingProductIds = q
    ? productRows.filter((product) => matchesText([product.name, product.sku], q)).map((product) => product.id)
    : [];

  let stockQuery = supabase
    .from("machine_storage_stock")
    .select("id, machine_id, location_id, product_id, product_name, quantity, notes, updated_at, created_at", { count: "exact" })
    .order("updated_at", { ascending: false })
    .order("machine_id")
    .order("product_name");

  if (machineId) stockQuery = stockQuery.eq("machine_id", machineId);
  if (productId) stockQuery = stockQuery.eq("product_id", productId);
  if (q) {
    const pattern = supabaseLikePattern(q.replaceAll(",", " "));
    const clauses = [`product_name.ilike.${pattern}`, `notes.ilike.${pattern}`];
    if (matchingMachineIds.length) clauses.push(`machine_id.in.(${matchingMachineIds.join(",")})`);
    if (matchingProductIds.length) clauses.push(`product_id.in.(${matchingProductIds.join(",")})`);
    stockQuery = stockQuery.or(clauses.join(","));
  }

  const { data: stockRows, count, error: stockError } = await stockQuery.range(from, to);
  if (stockError) {
    console.error("[inventory:machine-storage] Failed to load machine_storage_stock", stockError);
    return (
      <ErrorState
        title="Could not load machine storage"
        body="The machine storage projection could not be loaded from machine_storage_stock."
        action={<SecondaryButton href="/inventory/machine-storage">Retry</SecondaryButton>}
      />
    );
  }

  const rows = (stockRows ?? []) as MachineStorageRow[];
  const pageUnits = rows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity ?? 0)), 0);
  const pageMachines = new Set(rows.map((row) => row.machine_id)).size;
  const pageProducts = new Set(rows.map((row) => row.product_id ?? row.product_name ?? row.id)).size;

  return (
    <>
      <PageHeader
        title="Machine Storage"
        subtitle="Ledger-backed extra stock left at machines after routes. Quantities are projected from inventory movements and are never edited directly."
        action={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <SecondaryButton href="/inventory">Back to inventory</SecondaryButton>
            <SecondaryButton href="/inventory/movements">Movement log</SecondaryButton>
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visible rows</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{rows.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visible units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{pageUnits}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Machines on page</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{pageMachines}</div>
        </div>
        <div className="surface-card">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Products on page</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{pageProducts}</div>
        </div>
      </div>

      <section className="surface-card mb-6 space-y-4">
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input type="hidden" name="page" value="1" />
          <input type="hidden" name="pageSize" value={pageSize} />
          <div className="md:col-span-2 xl:col-span-2">
            <SearchInput defaultValue={q} placeholder="Search machine, location, product, or notes..." />
          </div>
          <select name="machine_id" defaultValue={machineId} className="field-input">
            <option value="">All machines</option>
            {machineRows.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {formatMachineDisplayName(machine, { includeArea: true })}
              </option>
            ))}
          </select>
          <select name="product_id" defaultValue={productId} className="field-input">
            <option value="">All products</option>
            {productRows.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}{product.sku ? ` (${product.sku})` : ""}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button className="btn-primary">Filter</button>
            <SecondaryButton href="/inventory/machine-storage">Reset</SecondaryButton>
          </div>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState
          title="No machine storage rows match these filters"
          body="Extra stock left at machines will appear here after route completion creates route_to_machine_storage movements."
          action={<SecondaryButton href="/inventory/machine-storage">Reset filters</SecondaryButton>}
        />
      ) : (
        <>
          <MobileCardList>
            {rows.map((row) => {
              const machine = machineById.get(row.machine_id) ?? null;
              const product = row.product_id ? productById.get(row.product_id) ?? null : null;
              const machineText = machine ? machineLabel(machine, row.machine_id) : shortId(row.machine_id);
              const locationText = machine ? locationLabel(machine, row) : row.location_id ? shortId(row.location_id) : "-";
              const productText = String(product?.name ?? row.product_name ?? "").trim() || "Unknown product";
              const skuText = String(product?.sku ?? "").trim();

              return (
                <MobileRecordCard key={row.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-500">{formatDate(row.updated_at)}</div>
                      <div className="mt-1 break-words text-base font-semibold text-slate-900">{productText}</div>
                      {skuText ? <div className="mt-1 text-sm text-slate-500">{skuText}</div> : null}
                    </div>
                    <div className="rounded-lg bg-slate-100 px-3 py-2 text-center">
                      <div className="text-xs text-slate-500">Qty</div>
                      <div className="text-lg font-semibold text-slate-900">{row.quantity}</div>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3">
                    <MobileField label="Machine">{machineText}</MobileField>
                    <MobileField label="Location">{locationText}</MobileField>
                    <MobileField label="State">
                      <StatusBadge status={stockStatus(row.quantity)} />
                    </MobileField>
                    <MobileField label="Notes">{row.notes || "-"}</MobileField>
                  </div>
                </MobileRecordCard>
              );
            })}
          </MobileCardList>

          <DataTable className="hidden md:block" headers={["Machine", "Product", "Qty", "Location", "Updated", "State", "Notes"]}>
            {rows.map((row) => {
              const machine = machineById.get(row.machine_id) ?? null;
              const product = row.product_id ? productById.get(row.product_id) ?? null : null;
              const machineText = machine ? machineLabel(machine, row.machine_id) : shortId(row.machine_id);
              const locationText = machine ? locationLabel(machine, row) : row.location_id ? shortId(row.location_id) : "-";
              const productText = String(product?.name ?? row.product_name ?? "").trim() || "Unknown product";
              const skuText = String(product?.sku ?? "").trim();

              return (
                <tr key={row.id}>
                  <td>{machineText}</td>
                  <td>
                    <div className="font-medium text-slate-900">{productText}</div>
                    {skuText ? <div className="mt-1 text-xs text-slate-500">{skuText}</div> : null}
                  </td>
                  <td className="font-semibold">{row.quantity}</td>
                  <td>{locationText}</td>
                  <td>{formatDate(row.updated_at)}</td>
                  <td><StatusBadge status={stockStatus(row.quantity)} /></td>
                  <td>{row.notes || "-"}</td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/inventory/machine-storage" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="machine storage rows" />
        </>
      )}
    </>
  );
}
