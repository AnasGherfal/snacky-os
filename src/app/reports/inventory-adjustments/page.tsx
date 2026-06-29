import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";

export const dynamic = "force-dynamic";

type InventoryAdjustmentReportRow = {
  id: string;
  adjustment_type: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | string | null;
  unit_cost_lyd: number | string | null;
  total_cost_lyd: number | string | null;
  reason: string | null;
  notes: string | null;
  photo_url: string | null;
  status: string | null;
  created_at: string | null;
  route_id: string | null;
  route_stop_id: string | null;
  machine_id: string | null;
  location_id: string | null;
  operator_id: string | null;
  route?: { id?: string | null; route_date?: string | null } | null;
  machine?: { id?: string | null; name?: string | null; machine_code?: string | null } | null;
  location?: { id?: string | null; name?: string | null } | null;
  operator?: { id?: string | null; full_name?: string | null } | null;
  product?: { id?: string | null; name?: string | null; sku?: string | null } | null;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function displayName(value: string | null | undefined, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currencyValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "-";
  return lyd(parsed);
}

export default async function InventoryAdjustmentsReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    adjustment_type?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  await requireCurrentProfileForPath("/reports");
  const params = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <ErrorState
        title="Inventory adjustments unavailable"
        body="Snacky OS could not connect to Supabase, so the adjustment report cannot load."
        action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>}
      />
    );
  }

  let query = supabase
    .from("inventory_adjustments")
    .select(
      "id, adjustment_type, product_id, product_name, quantity, unit_cost_lyd, total_cost_lyd, reason, notes, photo_url, status, created_at, route_id, route_stop_id, machine_id, location_id, operator_id, route:routes(id, route_date), machine:machines(id, name, machine_code), location:locations(id, name), operator:team_members(id, full_name), product:products(id, name, sku)",
    )
    .order("created_at", { ascending: false })
    .limit(500);

  if (params.adjustment_type && ["damaged", "returned_from_machine"].includes(params.adjustment_type)) {
    query = query.eq("adjustment_type", params.adjustment_type);
  }
  if (params.status && ["confirmed", "pending_storage_confirmation", "cancelled"].includes(params.status)) {
    query = query.eq("status", params.status);
  }
  if (params.date_from) query = query.gte("created_at", `${params.date_from}T00:00:00`);
  if (params.date_to) query = query.lte("created_at", `${params.date_to}T23:59:59`);

  const { data, error } = await query;
  if (error) {
    console.error("[reports:inventory-adjustments] Failed to load inventory adjustments", error);
    return (
      <ErrorState
        title="Could not load inventory adjustments"
        body="The adjustment report reads directly from inventory_adjustments, but that query failed."
        action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>}
      />
    );
  }

  const search = String(params.q ?? "").trim().toLowerCase();
  const rows = (data ?? []).filter((row: InventoryAdjustmentReportRow) => {
    if (!search) return true;
    return [
      row.product_name,
      row.reason,
      row.notes,
      row.status,
      row.adjustment_type,
      row.route?.route_date,
      row.machine?.name,
      row.machine?.machine_code,
      row.location?.name,
      row.operator?.full_name,
    ]
      .map((value) => String(value ?? "").toLowerCase())
      .join(" ")
      .includes(search);
  });

  const damagedRows = rows.filter((row) => row.adjustment_type === "damaged");
  const returnedRows = rows.filter((row) => row.adjustment_type === "returned_from_machine");
  const damagedQuantity = damagedRows.reduce((sum, row) => sum + numberValue(row.quantity), 0);
  const returnedQuantity = returnedRows.reduce((sum, row) => sum + numberValue(row.quantity), 0);
  const damagedLoss = damagedRows.reduce((sum, row) => sum + numberValue(row.total_cost_lyd), 0);
  const returnedValue = returnedRows.reduce((sum, row) => sum + numberValue(row.total_cost_lyd), 0);

  return (
    <>
      <PageHeader
        title="Inventory Adjustments"
        subtitle="Damaged products and returned-from-machine movements recorded during route execution."
        action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>}
      />

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-4">
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search product, route, machine, reason..." className="field-input md:col-span-2" />
          <select name="adjustment_type" defaultValue={params.adjustment_type ?? ""} className="field-input">
            <option value="">All adjustment types</option>
            <option value="damaged">Damaged</option>
            <option value="returned_from_machine">Returned from machine</option>
          </select>
          <select name="status" defaultValue={params.status ?? ""} className="field-input">
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending_storage_confirmation">Pending storage confirmation</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input name="date_from" type="date" defaultValue={params.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={params.date_to ?? ""} className="field-input" />
          <div className="flex gap-2 md:col-span-2">
            <button className="btn-primary">Filter</button>
            <Link href="/reports/inventory-adjustments" className="btn-secondary">Reset</Link>
          </div>
        </form>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Damaged units</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{damagedQuantity}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Returned units</div>
          <div className="mt-1 text-3xl font-semibold text-slate-900">{returnedQuantity}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Estimated damaged loss</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{lyd(damagedLoss)}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Returned value</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{lyd(returnedValue)}</div>
        </div>
      </section>

      {!rows.length ? (
        <EmptyState
          title="No inventory adjustments found"
          body="Damaged and returned products will appear here after operators save them during route execution."
        />
      ) : (
        <DataTable headers={["Created", "Type", "Product", "Qty", "Route", "Machine / Location", "Operator", "Reason", "Cost / Loss", "Status"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDateTime(row.created_at)}</td>
              <td><StatusBadge status={row.adjustment_type} /></td>
              <td>
                <div className="font-medium text-slate-900">{displayName(row.product_name ?? row.product?.name, "Unknown product")}</div>
                {row.product?.sku ? <div className="text-xs text-slate-500">{row.product.sku}</div> : null}
              </td>
              <td>{numberValue(row.quantity)}</td>
              <td>{row.route?.route_date ? `Route ${row.route.route_date}` : row.route_id ? `Route ${row.route_id.slice(0, 8)}` : "-"}</td>
              <td>
                <div className="font-medium text-slate-900">{displayName(row.machine?.name, "Unknown machine")}</div>
                <div className="text-xs text-slate-500">
                  {row.machine?.machine_code ?? row.location?.name ?? "Unknown location"}
                </div>
              </td>
              <td>{displayName(row.operator?.full_name, "Unknown operator")}</td>
              <td>{row.reason ?? "-"}</td>
              <td>{currencyValue(row.total_cost_lyd)}</td>
              <td><StatusBadge status={row.status} /></td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
