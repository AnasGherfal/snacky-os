import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName, relationRecord } from "@/lib/machine-site-display";

export const dynamic = "force-dynamic";

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function currentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  return { start, end: now.toISOString().slice(0, 10) };
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function formatDateTime(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function missingTable(error: unknown, table: string) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes(table);
}

function returnPostingLabel(status: unknown) {
  const value = String(status ?? "").toLowerCase();
  if (value === "confirmed") return "Stock movement posted";
  if (value === "pending_storage_confirmation") return "With operator — awaiting storage return";
  if (value === "cancelled") return "Cancelled";
  return "Needs review";
}

export default async function RouteProductActivityPage({ searchParams }: { searchParams: Promise<{ date_from?: string; date_to?: string; q?: string }> }) {
  await requireCurrentProfileForPath("/reports");
  const params = await searchParams;
  const defaults = currentMonthRange();
  const dateFrom = dateOnly(params.date_from) ?? defaults.start;
  const dateTo = dateOnly(params.date_to) ?? defaults.end;
  const search = String(params.q ?? "").trim().toLowerCase();
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Product activity unavailable" body="Snacky OS could not connect to Supabase." />;

  const endExclusive = nextDate(dateTo);
  const [manualResult, adjustmentResult, stopResult, safetyResult, vmsSummaryResult] = await Promise.all([
    supabase
      .from("route_manual_sales")
      .select("id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, notes, sale_time, status, inventory_movement_id, machine:machines(id, name, machine_code, location:locations(id, name)), operator:team_members(id, full_name), product:products(id, name, sku)")
      .gte("sale_time", `${dateFrom}T00:00:00`)
      .lt("sale_time", `${endExclusive}T00:00:00`)
      .order("sale_time", { ascending: false })
      .limit(2000),
    supabase
      .from("inventory_adjustments")
      .select("id, adjustment_type, product_id, product_name, quantity, unit_cost_lyd, total_cost_lyd, reason, notes, photo_url, status, created_at, route_id, route_stop_id, machine_id, operator_id, machine:machines(id, name, machine_code, location:locations(id, name)), operator:team_members(id, full_name), product:products(id, name, sku)")
      .gte("created_at", `${dateFrom}T00:00:00`)
      .lt("created_at", `${endExclusive}T00:00:00`)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("route_stops")
      .select("id, route_id, machine_id, status, completed_at, route:routes(id, operator_id), machine:machines(id, name, machine_code, location:locations(id, name))")
      .eq("status", "completed")
      .gte("completed_at", `${dateFrom}T00:00:00`)
      .lt("completed_at", `${endExclusive}T00:00:00`)
      .limit(5000),
    supabase
      .from("route_stop_safety_checks")
      .select("id, route_id, route_stop_id, machine_id, operator_id, compressor_confirmed, proof_photo_url, proof_photo_path, confirmed_at, machine:machines(id, name, machine_code, location:locations(id, name)), operator:team_members(id, full_name)")
      .gte("confirmed_at", `${dateFrom}T00:00:00`)
      .lt("confirmed_at", `${endExclusive}T00:00:00`)
      .order("confirmed_at", { ascending: false })
      .limit(5000),
    supabase.rpc("sales_dashboard_monthly_summary", { p_date_from: dateFrom, p_date_to: dateTo }),
  ]);

  if (manualResult.error && !missingTable(manualResult.error, "route_manual_sales")) console.error("[route-product-activity] Manual sales query failed", manualResult.error);
  if (adjustmentResult.error && !missingTable(adjustmentResult.error, "inventory_adjustments")) console.error("[route-product-activity] Adjustment query failed", adjustmentResult.error);
  if (stopResult.error) console.error("[route-product-activity] Completed stop query failed", stopResult.error);
  const safetyInstalled = !safetyResult.error || !missingTable(safetyResult.error, "route_stop_safety_checks");
  if (safetyResult.error && safetyInstalled) console.error("[route-product-activity] Safety proof query failed", safetyResult.error);

  const manualRows = (manualResult.data ?? []).filter((row: any) => row.status === "confirmed").filter((row: any) => !search || [row.product_name, relationRecord(row.product)?.name, relationRecord(row.operator)?.full_name, formatMachineDisplayName(relationRecord(row.machine), { includeArea: true })].join(" ").toLowerCase().includes(search));
  const adjustmentRows = (adjustmentResult.data ?? []).filter((row: any) => !search || [row.product_name, row.reason, relationRecord(row.product)?.name, relationRecord(row.operator)?.full_name, formatMachineDisplayName(relationRecord(row.machine), { includeArea: true })].join(" ").toLowerCase().includes(search));
  const damagedRows = adjustmentRows.filter((row: any) => row.adjustment_type === "damaged");
  const returnedRows = adjustmentRows.filter((row: any) => row.adjustment_type === "returned_from_machine");
  const manualUnits = manualRows.reduce((sum: number, row: any) => sum + numberValue(row.quantity), 0);
  const manualRevenue = manualRows.reduce((sum: number, row: any) => sum + numberValue(row.total_amount_lyd), 0);
  const manualStockWarnings = manualRows.filter((row: any) => !row.inventory_movement_id).length;
  const damagedUnits = damagedRows.reduce((sum: number, row: any) => sum + numberValue(row.quantity), 0);
  const damagedCost = damagedRows.reduce((sum: number, row: any) => sum + numberValue(row.total_cost_lyd), 0);
  const returnedUnits = returnedRows.reduce((sum: number, row: any) => sum + numberValue(row.quantity), 0);
  const returnedPosted = returnedRows.filter((row: any) => row.status === "confirmed").reduce((sum: number, row: any) => sum + numberValue(row.quantity), 0);
  const returnedPending = returnedRows.filter((row: any) => row.status === "pending_storage_confirmation").reduce((sum: number, row: any) => sum + numberValue(row.quantity), 0);
  const completedStops = stopResult.data ?? [];
  const safetyRows = safetyResult.data ?? [];
  const proofStopIds = new Set(safetyRows.filter((row: any) => row.compressor_confirmed && (row.proof_photo_url || row.proof_photo_path)).map((row: any) => String(row.route_stop_id)));
  const compressorMissing = safetyInstalled ? completedStops.filter((row: any) => !proofStopIds.has(String(row.id))).length : 0;
  const vmsSummary = Array.isArray(vmsSummaryResult.data) ? vmsSummaryResult.data[0] : vmsSummaryResult.data;
  const vmsRevenue = numberValue((vmsSummary as any)?.revenue_amount);
  const vmsUnits = numberValue((vmsSummary as any)?.units_sold);

  return (
    <>
      <PageHeader title="Route Product Activity" subtitle="One dashboard for operator-entered sales, damaged products, machine returns, stock-posting status, and compressor proof." action={<SecondaryButton href="/reports">Back to reports</SecondaryButton>} />
      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-4">
          <input name="q" defaultValue={params.q ?? ""} className="field-input md:col-span-2" placeholder="Search product, operator, machine..." />
          <input name="date_from" type="date" defaultValue={dateFrom} className="field-input" />
          <input name="date_to" type="date" defaultValue={dateTo} className="field-input" />
          <div className="flex gap-2 md:col-span-4"><button className="btn-primary">Apply</button><Link href="/reports/route-product-activity" className="btn-secondary">Current month</Link></div>
        </form>
      </section>

      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Combined total sales</div><div className="mt-1 text-3xl font-semibold">{lyd(vmsRevenue + manualRevenue)}</div><div className="mt-1 text-xs text-slate-500">VMS {lyd(vmsRevenue)} + route-entered {lyd(manualRevenue)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Route-entered sales</div><div className="mt-1 text-3xl font-semibold">{manualUnits}</div><div className="mt-1 text-xs text-slate-500">{lyd(manualRevenue)} · {manualStockWarnings} stock-posting review</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Damaged products</div><div className="mt-1 text-3xl font-semibold">{damagedUnits}</div><div className="mt-1 text-xs text-slate-500">Estimated loss {lyd(damagedCost)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Returned from machines</div><div className="mt-1 text-3xl font-semibold">{returnedUnits}</div><div className="mt-1 text-xs text-slate-500">{returnedPosted} posted · {returnedPending} awaiting storage</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">VMS sold units</div><div className="mt-1 text-3xl font-semibold">{vmsUnits}</div><div className="mt-1 text-xs text-slate-500">VMS source only</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Compressor proof</div><div className="mt-1 text-3xl font-semibold">{safetyInstalled ? `${proofStopIds.size}/${completedStops.length}` : "Setup"}</div><div className="mt-1 text-xs text-slate-500">{safetyInstalled ? `${compressorMissing} completed stop(s) missing proof` : "Apply safety migration"}</div></div>
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-lg font-semibold text-slate-950">Operator-entered sales</h2>
        <p className="mt-1 text-sm text-slate-500">Confirmed entries are included in combined total sales above.</p>
        {!manualRows.length ? <div className="mt-4"><EmptyState title="No route-entered sales" body="Sales saved by operators during refill will appear here." /></div> : (
          <div className="mt-4"><DataTable headers={["Time", "Product", "Qty", "Amount", "Payment", "Machine", "Operator", "Stock posting"]}>{manualRows.map((row: any) => { const machine = relationRecord(row.machine); const operator = relationRecord(row.operator); return <tr key={row.id}><td>{formatDateTime(row.sale_time)}</td><td className="font-medium">{row.product_name}</td><td>{numberValue(row.quantity)}</td><td>{lyd(numberValue(row.total_amount_lyd))}</td><td>{row.payment_method}</td><td>{formatMachineDisplayName(machine, { includeArea: true })}</td><td>{operator?.full_name ?? "-"}</td><td><StatusBadge status={row.inventory_movement_id ? "confirmed" : "pending"} label={row.inventory_movement_id ? "Stock reduced" : "Review stock"} /></td></tr>; })}</DataTable></div>
        )}
      </section>

      <section className="surface-card mb-6">
        <h2 className="text-lg font-semibold text-slate-950">Damaged and returned products</h2>
        <p className="mt-1 text-sm text-slate-500">Returned status clearly shows whether the stock movement was posted or is still waiting for storage confirmation.</p>
        {!adjustmentRows.length ? <div className="mt-4"><EmptyState title="No damaged or returned products" body="Operator adjustments will appear here." /></div> : (
          <div className="mt-4"><DataTable headers={["Time", "Type", "Product", "Qty", "Machine", "Operator", "Reason", "Value", "Inventory result", "Proof"]}>{adjustmentRows.map((row: any) => { const machine = relationRecord(row.machine); const operator = relationRecord(row.operator); return <tr key={row.id}><td>{formatDateTime(row.created_at)}</td><td><StatusBadge status={row.adjustment_type} /></td><td className="font-medium">{row.product_name}</td><td>{numberValue(row.quantity)}</td><td>{formatMachineDisplayName(machine, { includeArea: true })}</td><td>{operator?.full_name ?? "-"}</td><td>{row.reason ?? "-"}</td><td>{lyd(numberValue(row.total_cost_lyd))}</td><td>{row.adjustment_type === "returned_from_machine" ? <StatusBadge status={row.status === "confirmed" ? "confirmed" : "pending"} label={returnPostingLabel(row.status)} /> : <StatusBadge status={row.status ?? "confirmed"} />}</td><td>{row.photo_url ? <a href={row.photo_url} target="_blank" rel="noreferrer" className="link-secondary">Photo</a> : "-"}</td></tr>; })}</DataTable></div>
        )}
      </section>

      <section className="surface-card">
        <h2 className="text-lg font-semibold text-slate-950">Compressor safety compliance</h2>
        {!safetyInstalled ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Apply migration 202607180001_route_stop_compressor_safety.sql. Existing route completion remains available until it is installed.</div> : !safetyRows.length ? <div className="mt-4"><EmptyState title="No compressor proofs yet" body="Proofs saved after refill will appear here." /></div> : (
          <div className="mt-4"><DataTable headers={["Confirmed", "Machine", "Operator", "Status", "Photo"]}>{safetyRows.map((row: any) => { const machine = relationRecord(row.machine); const operator = relationRecord(row.operator); return <tr key={row.id}><td>{formatDateTime(row.confirmed_at)}</td><td>{formatMachineDisplayName(machine, { includeArea: true })}</td><td>{operator?.full_name ?? "-"}</td><td><StatusBadge status={row.compressor_confirmed ? "confirmed" : "pending"} label={row.compressor_confirmed ? "Compressor ON" : "Missing"} /></td><td>{row.proof_photo_url ? <a href={row.proof_photo_url} target="_blank" rel="noreferrer" className="link-secondary">View proof</a> : row.proof_photo_path ? "Saved" : "-"}</td></tr>; })}</DataTable></div>
        )}
      </section>
    </>
  );
}
