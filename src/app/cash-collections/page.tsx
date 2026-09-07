import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canRecordCashRemoval, canViewFinancials } from "@/lib/authz";
import { cashCustodyStatusLabel, combinedCashPosition, getCashCustodyAlerts, missingCashAmount } from "@/lib/cash-custody";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { cleanSearchParams, getPagination, type SearchParamsRecord } from "@/lib/pagination";

const custodyStatusFilters = [
  { value: "waiting", label: "Waiting to be counted" },
  { value: "counted", label: "Counted — VMS check pending" },
  { value: "reconciled", label: "Counted & reconciled" },
  { value: "voided", label: "Voided" },
];

function applyCustodyStatusFilter(query: any, status: string | undefined) {
  if (status === "waiting") return query.in("custody_status", ["removed", "in_storage"]);
  if (status === "counted") return query.eq("custody_status", "counted");
  if (status === "reconciled") return query.in("custody_status", ["reconciled", "banked"]);
  if (status === "voided") return query.eq("custody_status", "voided");
  return query;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(new Date(value));
}

function money(value: number | string | null | undefined) {
  return value === null || value === undefined ? "—" : lyd(Number(value));
}

function singleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function machineSummary(row: any) {
  const links = (row.machine_links ?? []) as Array<{ machine?: any }>;
  if (links.length === 1) return formatMachineDisplayName(links[0].machine ?? null, { includeArea: true });
  if (links.length > 1) return `${links.length} machines — one sealed batch`;
  return "Cash batch";
}

export default async function CashCollectionsPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { error?: string; success?: string; status?: string; machine_id?: string; operator_id?: string; date_from?: string; date_to?: string }> }) {
  const params = cleanSearchParams(await searchParams);
  const statusParam = singleParam(params.status);
  const machineParam = singleParam(params.machine_id);
  const operatorParam = singleParam(params.operator_id);
  const dateFromParam = singleParam(params.date_from);
  const dateToParam = singleParam(params.date_to);
  const errorMessage = singleParam(params.error);
  const successMessage = singleParam(params.success);
  const { page, pageSize, from, to } = getPagination(params);
  const profile = await getCurrentProfile();
  const context = profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null;
  if (!profile || !canAccessPath(context, "/cash-collections")) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Cash custody unavailable" body="Supabase is not configured." />;
  const canSeeMoney = canViewFinancials(context);

  if (!canSeeMoney) {
    let query = supabase
      .from("cash_removal_receipts")
      .select("cash_collection_id, operator_id, cash_bag_id, collected_at, custody_status, storage_received_at, storage_location, operator:team_members!cash_removal_receipts_operator_id_fkey(id, full_name), machine_links:cash_removal_receipt_machines(removal_type, compartments, machine:machines(id, name, machine_code, location:locations(id, name)))", { count: "exact" })
      .order("collected_at", { ascending: false });
    query = applyCustodyStatusFilter(query, statusParam);
    if (dateFromParam) query = query.gte("collected_at", `${dateFromParam}T00:00:00+02:00`);
    if (dateToParam) query = query.lte("collected_at", `${dateToParam}T23:59:59+02:00`);
    const { data, count, error } = await query.range(from, to);
    if (error) {
      console.error("[cash] Failed to load amount-free handoff queue", error);
      return <ErrorState title="Could not load storage handoffs" body="The amount-free custody receipt query failed." action={<SecondaryButton href="/cash-collections">Retry</SecondaryButton>} />;
    }
    const rows = data ?? [];
    const overdue = rows.filter((row: any) => getCashCustodyAlerts(row).length > 0).length;

    return (
      <div className="space-y-6">
        <PageHeader title="Cash Storage Handoffs" subtitle="Verify sealed bags and storage locations. Financial amounts are deliberately hidden from this operational queue." />
        {errorMessage ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{errorMessage}</div> : null}
        {successMessage ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{successMessage}</div> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <SectionCard><div className="text-sm text-slate-500">Visible handoffs</div><div className="mt-2 text-2xl font-semibold">{count ?? rows.length}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Awaiting storage</div><div className="mt-2 text-2xl font-semibold">{rows.filter((row: any) => row.custody_status === "removed").length}</div></SectionCard>
          <SectionCard><div className="text-sm text-slate-500">Overdue on this page</div><div className={`mt-2 text-2xl font-semibold ${overdue ? "text-rose-700" : ""}`}>{overdue}</div></SectionCard>
        </div>
        <section className="surface-card"><form className="grid gap-3 sm:grid-cols-4"><input type="hidden" name="pageSize" value={pageSize} /><select name="status" defaultValue={statusParam ?? ""} className="field-input"><option value="">All cash</option>{custodyStatusFilters.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select><input name="date_from" type="date" defaultValue={dateFromParam ?? ""} className="field-input" /><input name="date_to" type="date" defaultValue={dateToParam ?? ""} className="field-input" /><div className="flex gap-2"><button className="btn-primary">Filter</button><Link href="/cash-collections" className="btn-secondary">Reset</Link></div></form></section>
        {!rows.length ? <EmptyState title="No cash handoffs found" body="Sealed removals will appear here without financial amounts." /> : <>
          <MobileCardList>{rows.map((row: any) => { const alerts = getCashCustodyAlerts(row); return <MobileRecordCard key={row.cash_collection_id} className={alerts.length ? "border-amber-200 bg-amber-50/40" : ""}><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">Bag {row.cash_bag_id}</h2><p className="mt-1 text-xs text-slate-500">{machineSummary(row)}</p></div><StatusBadge status={row.custody_status} label={cashCustodyStatusLabel(row.custody_status)} /></div><div className="mt-4 grid grid-cols-2 gap-3"><MobileField label="Removed">{formatDate(row.collected_at)}</MobileField><MobileField label="Collector">{row.operator?.full_name ?? "—"}</MobileField><MobileField label="Stored">{formatDate(row.storage_received_at)}</MobileField><MobileField label="Location">{row.storage_location ?? "—"}</MobileField></div>{alerts.length ? <p className="mt-3 text-sm font-semibold text-rose-700">{alerts[0].label}</p> : null}<Link href={`/cash-collections/${row.cash_collection_id}`} className="btn-secondary mt-4 w-full">Open handoff</Link></MobileRecordCard>; })}</MobileCardList>
          <DataTable className="hidden md:block" headers={["Bag / machines", "Collector", "Removed", "Storage", "Stage", "Alert", "Action"]}>{rows.map((row: any) => { const alerts = getCashCustodyAlerts(row); return <tr key={row.cash_collection_id}><td><div className="font-semibold">{row.cash_bag_id}</div><div className="text-xs text-slate-500">{machineSummary(row)}</div></td><td>{row.operator?.full_name ?? "—"}</td><td>{formatDate(row.collected_at)}</td><td><div>{formatDate(row.storage_received_at)}</div><div className="text-xs text-slate-500">{row.storage_location ?? "—"}</div></td><td><StatusBadge status={row.custody_status} label={cashCustodyStatusLabel(row.custody_status)} /></td><td>{alerts.length ? <span className="font-semibold text-rose-700">{alerts[0].label}</span> : "—"}</td><td><Link href={`/cash-collections/${row.cash_collection_id}`} className="btn-secondary px-3 py-2">Open</Link></td></tr>; })}</DataTable>
          <PaginationControls basePath="/cash-collections" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="cash handoffs" />
        </>}
      </div>
    );
  }

  const [{ data: machines }, { data: operators }] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").order("name"),
    supabase.from("team_members").select("id, full_name").order("full_name"),
  ]);
  let linkedIds: string[] = [];
  if (machineParam) {
    const linkedIdSet = new Set<string>();
    const chunkSize = 1_000;
    for (let offset = 0; ; offset += chunkSize) {
      const { data, error } = await supabase
        .from("cash_collection_machines")
        .select("cash_collection_id")
        .eq("machine_id", machineParam)
        .order("cash_collection_id")
        .range(offset, offset + chunkSize - 1);
      if (error) {
        console.error("[cash] Failed to load machine-linked custody batches", error);
        return <ErrorState title="Could not filter cash custody" body="The machine custody-link query failed." action={<SecondaryButton href="/cash-collections">Reset filter</SecondaryButton>} />;
      }
      const chunk = data ?? [];
      for (const row of chunk) linkedIdSet.add(String(row.cash_collection_id));
      if (chunk.length < chunkSize) break;
    }
    linkedIds = Array.from(linkedIdSet);
  }
  const applyFilters = (query: any) => {
    query = applyCustodyStatusFilter(query, statusParam);
    if (machineParam) query = linkedIds.length ? query.in("id", linkedIds) : query.eq("machine_id", machineParam);
    if (operatorParam) query = query.eq("operator_id", operatorParam);
    if (dateFromParam) query = query.gte("collected_at", `${dateFromParam}T00:00:00+02:00`);
    if (dateToParam) query = query.lte("collected_at", `${dateToParam}T23:59:59+02:00`);
    return query;
  };
  const detailSelect = "id, operator_id, collected_at, actual_cash_collected, vms_expected_cash, variance, review_status, custody_status, reconciliation_status, cash_bag_id, storage_received_at, counted_at, reconciled_at, storage_seal_condition, count_seal_condition, expected_source, operator:team_members!cash_collections_operator_id_fkey(id, full_name), machine_links:cash_collection_machines(removal_type, machine:machines(id, name, machine_code, location:locations(id, name)))";
  const loadSummaryRows = async () => {
    const allRows: any[] = [];
    const chunkSize = 1_000;
    for (let offset = 0; ; offset += chunkSize) {
      const result = await applyFilters(
        supabase
          .from("cash_collections")
          .select("id, actual_cash_collected, vms_expected_cash, custody_status, reconciliation_status, collected_at, storage_received_at, counted_at, reconciled_at, storage_seal_condition, count_seal_condition")
          .order("id"),
      ).range(offset, offset + chunkSize - 1);
      if (result.error) return { data: allRows, error: result.error };
      const chunk = result.data ?? [];
      allRows.push(...chunk);
      if (chunk.length < chunkSize) return { data: allRows, error: null };
    }
  };
  const [pageResult, summaryResult] = await Promise.all([
    applyFilters(supabase.from("cash_collections").select(detailSelect, { count: "exact" }).order("collected_at", { ascending: false })).range(from, to),
    loadSummaryRows(),
  ]);
  if (pageResult.error || summaryResult.error) {
    console.error("[cash] Failed to load custody control center", pageResult.error ?? summaryResult.error);
    return <ErrorState title="Could not load cash custody" body="The custody query failed. Apply the cash-chain migration together with this application version." action={<SecondaryButton href="/cash-collections">Retry</SecondaryButton>} />;
  }
  const rows = pageResult.data ?? [];
  const summaryRows = summaryResult.data ?? [];
  const totalAvailableCash = summaryRows.filter((row: any) => ["counted", "reconciled", "banked"].includes(row.custody_status)).reduce((sum: number, row: any) => sum + Number(row.actual_cash_collected ?? 0), 0);
  const combinedPosition = combinedCashPosition(summaryRows.filter((row: any) => row.custody_status !== "voided"));
  const totalMissing = combinedPosition.missingCash;
  const waitingCount = summaryRows.filter((row: any) => ["removed", "in_storage"].includes(row.custody_status)).length;
  const needsCheckCount = summaryRows.filter((row: any) => row.custody_status === "counted").length;
  const actions = canRecordCashRemoval(context) ? <PrimaryButton href="/cash-collections/new">Record removal</PrimaryButton> : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Cash Custody Control" subtitle="Remove and seal the cash, count it into Snacky LYD, then compare the combined total against VMS. Cash is never tied to route completion." action={actions} />
      {errorMessage ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{errorMessage}</div> : null}
      {successMessage ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{successMessage}</div> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SectionCard><div className="text-sm text-slate-500">Available Snacky cash</div><div className="mt-2 text-2xl font-semibold">{lyd(totalAvailableCash)}</div><div className="mt-1 text-xs text-slate-500">Counted cash already added to Snacky LYD</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Net missing for filters</div><div className={`mt-2 text-2xl font-semibold ${totalMissing > 0 ? "text-rose-700" : ""}`}>{lyd(totalMissing)}</div><div className="mt-1 text-xs text-slate-500">Combined expected minus counted across {combinedPosition.batchCount} verified batch{combinedPosition.batchCount === 1 ? "" : "es"}; overages offset shortages</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Waiting to be counted</div><div className={`mt-2 text-2xl font-semibold ${waitingCount ? "text-amber-700" : ""}`}>{waitingCount}</div></SectionCard>
        <SectionCard><div className="text-sm text-slate-500">Needs VMS check / review</div><div className={`mt-2 text-2xl font-semibold ${needsCheckCount ? "text-rose-700" : ""}`}>{needsCheckCount}</div></SectionCard>
      </div>
      <section className="surface-card"><form className="grid gap-3 md:grid-cols-3 xl:grid-cols-7"><input type="hidden" name="pageSize" value={pageSize} /><select name="status" defaultValue={statusParam ?? ""} className="field-input"><option value="">All cash</option>{custodyStatusFilters.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select><select name="machine_id" defaultValue={machineParam ?? ""} className="field-input"><option value="">All machines</option>{(machines ?? []).map((machine: any) => <option key={machine.id} value={machine.id}>{formatMachineDisplayName(machine, { includeArea: true })}</option>)}</select><select name="operator_id" defaultValue={operatorParam ?? ""} className="field-input"><option value="">All collectors</option>{(operators ?? []).map((operator: any) => <option key={operator.id} value={operator.id}>{operator.full_name}</option>)}</select><input name="date_from" type="date" defaultValue={dateFromParam ?? ""} className="field-input" /><input name="date_to" type="date" defaultValue={dateToParam ?? ""} className="field-input" /><button className="btn-primary">Filter</button><Link href="/cash-collections" className="btn-secondary">Reset</Link></form></section>
      {!rows.length ? <EmptyState title="No cash batches found" body="Record a sealed removal or change the filters." action={canRecordCashRemoval(context) ? <PrimaryButton href="/cash-collections/new">Record removal</PrimaryButton> : undefined} /> : <>
        <MobileCardList>{rows.map((row: any) => { const alerts = getCashCustodyAlerts(row); const shortage = missingCashAmount(row.actual_cash_collected, row.vms_expected_cash); return <MobileRecordCard key={row.id} className={alerts.some((alert) => alert.severity === "critical") ? "border-rose-200 bg-rose-50/30" : alerts.length ? "border-amber-200 bg-amber-50/30" : ""}><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">Bag {row.cash_bag_id ?? row.id.slice(0, 8)}</h2><p className="mt-1 text-xs text-slate-500">{machineSummary(row)}</p></div><StatusBadge status={row.custody_status} label={cashCustodyStatusLabel(row.custody_status)} /></div><div className="mt-4 grid grid-cols-2 gap-3"><MobileField label="Counted">{money(row.actual_cash_collected)}</MobileField><MobileField label="Missing">{money(shortage)}</MobileField><MobileField label="Removed">{formatDate(row.collected_at)}</MobileField><MobileField label="Collector">{row.operator?.full_name ?? "—"}</MobileField></div>{alerts.length ? <p className="mt-3 text-sm font-semibold text-rose-700">{alerts[0].label}</p> : null}<Link href={`/cash-collections/${row.id}`} className="btn-secondary mt-4 w-full">Open custody chain</Link></MobileRecordCard>; })}</MobileCardList>
        <DataTable className="hidden md:block" headers={["Bag / machines", "Collector", "Removed", "Counted", "Missing", "Stage", "Control alert", "Action"]}>{rows.map((row: any) => { const alerts = getCashCustodyAlerts(row); const shortage = missingCashAmount(row.actual_cash_collected, row.vms_expected_cash); return <tr key={row.id} className={alerts.some((alert) => alert.severity === "critical") ? "bg-rose-50/50" : alerts.length ? "border-amber-200 bg-amber-50/50" : ""}><td><div className="font-semibold">{row.cash_bag_id ?? row.id.slice(0, 8)}</div><div className="text-xs text-slate-500">{machineSummary(row)}</div></td><td>{row.operator?.full_name ?? "—"}</td><td>{formatDate(row.collected_at)}</td><td>{money(row.actual_cash_collected)}</td><td><span className={shortage && shortage > 0 ? "font-semibold text-rose-700" : ""}>{money(shortage)}</span></td><td><StatusBadge status={row.custody_status} label={cashCustodyStatusLabel(row.custody_status)} /></td><td>{alerts.length ? <span className="font-semibold text-rose-700">{alerts[0].label}</span> : "—"}</td><td><Link href={`/cash-collections/${row.id}`} className="btn-secondary px-3 py-2">Open</Link></td></tr>; })}</DataTable>
        <PaginationControls basePath="/cash-collections" searchParams={params} page={page} pageSize={pageSize} totalCount={pageResult.count ?? 0} itemLabel="cash batches" />
      </>}
    </div>
  );
}
