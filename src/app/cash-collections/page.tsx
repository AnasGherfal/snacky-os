import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { createMissingCashFinanceLinks } from "@/lib/cash-actions";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { getCashCollectionStatus } from "@/lib/cash-collections";
import { lyd } from "@/lib/format";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";

const statusOptions = ["pending_collection", "collected_pending_count", "counted_confirmed", "variance_review", "voided"];

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function money(value: number | string | null | undefined) {
  return value === null || value === undefined ? "-" : lyd(Number(value));
}

function singleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CashCollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    success?: string;
    status?: string;
    machine_id?: string;
    operator_id?: string;
    date_from?: string;
    date_to?: string;
    variance_review?: string;
  } & SearchParamsRecord>;
}) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/cash-collections")) {
    redirect("/unauthorized");
  }
  const canReviewMoney = canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Cash collections unavailable" body="Supabase is not configured, so Snacky OS cannot load cash collections." />
      </>
    );
  }

  const [{ data: machines, error: machinesError }, { data: operators, error: operatorsError }] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location:locations(id, name)").order("name"),
    supabase.from("team_members").select("id, full_name").order("full_name"),
  ]);
  const filterLoadError = machinesError ?? operatorsError;
  if (filterLoadError) {
    console.error("[cash] Failed to load cash collection filters", filterLoadError);
    return (
      <>
        <ErrorState title="Could not load cash filters" body="Snacky OS could not load machine or operator options for cash collections." action={<SecondaryButton href="/cash-collections">Retry</SecondaryButton>} />
      </>
    );
  }

  let query = supabase
    .from("cash_collections")
    .select(
      "id, route_id, machine_id, operator_id, collected_at, vms_expected_cash, actual_cash_collected, variance, review_status, cash_bag_id, counted_at, notes, machine:machines(id, name, machine_code, location:locations(id, name)), operator:team_members!cash_collections_operator_id_fkey(id, full_name), route:routes(id, route_date)",
      { count: "exact" },
    )
    .order("collected_at", { ascending: false });

  const statusFilter = singleParam(params.variance_review) === "1" ? "variance_review" : singleParam(params.status);
  if (statusFilter && statusOptions.includes(statusFilter)) query = query.eq("review_status", statusFilter);
  if (params.machine_id) query = query.eq("machine_id", params.machine_id);
  if (params.operator_id) query = query.eq("operator_id", params.operator_id);
  if (params.date_from) query = query.gte("collected_at", `${params.date_from}T00:00:00`);
  if (params.date_to) query = query.lte("collected_at", `${params.date_to}T23:59:59`);

  const { data: collections, count, error: collectionsError } = await query.range(from, to);
  if (collectionsError) {
    console.error("[cash] Failed to load cash collections", collectionsError);
    return (
      <>
        <ErrorState title="Could not load cash collections" body="The cash collection page reads real Supabase rows, but the query failed." action={<SecondaryButton href="/cash-collections">Retry</SecondaryButton>} />
      </>
    );
  }

  const rows = collections ?? [];
  const cashIds = rows.map((row: any) => row.id);
  const { data: financeRows, error: financeError } = cashIds.length
    ? await supabase
        .from("financial_transactions")
        .select("id, linked_cash_collection_id, source_type, source_id, transaction_status")
        .or(`linked_cash_collection_id.in.(${cashIds.join(",")}),and(source_type.eq.cash_collection,source_id.in.(${cashIds.join(",")}))`)
    : { data: [], error: null };
  if (financeError) console.error("[cash] Failed to load linked finance rows", financeError);
  const financeByCashId = new Map<string, any>();
  for (const row of (financeRows ?? []) as any[]) {
    const cashId = row.linked_cash_collection_id ?? (row.source_type === "cash_collection" ? row.source_id : null);
    if (cashId) financeByCashId.set(cashId, row);
  }
  const activeRows = rows.filter((row: any) => getCashCollectionStatus(row.review_status, row.variance) !== "voided");
  const rowsMissingFinance = activeRows.filter((row: any) => row.actual_cash_collected !== null && row.actual_cash_collected !== undefined && !financeByCashId.has(row.id));
  const totalCounted = activeRows.reduce((sum: number, row: any) => sum + Number(row.actual_cash_collected ?? 0), 0);
  const pendingCount = rows.filter((row: any) => row.review_status === "collected_pending_count").length;

  return (
    <>
      <PageHeader
        title="Cash Collections"
        subtitle="Record every physical cash pickup and counted amount. Expected cash and shortage/overage are reconciled for the full machine month in Finance Operations."
        action={canReviewMoney ? <PrimaryButton href="/cash-collections/new">New cash collection</PrimaryButton> : undefined}
      />
      {params.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.error}</div> : null}
      {params.success ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{params.success}</div> : null}
      {financeError ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-semibold">Could not read linked finance transactions.</div>
          <p className="mt-1">Cash collections are still shown below. Rows that should have finance links are marked as Finance link missing until the DB policy/schema is repaired.</p>
          {canReviewMoney ? (
            <form action={createMissingCashFinanceLinks} className="mt-3">
              <button className="btn-secondary px-3 py-2">Create missing finance links</button>
            </form>
          ) : null}
        </div>
      ) : rowsMissingFinance.length ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-semibold">{rowsMissingFinance.length} cash collection finance link{rowsMissingFinance.length === 1 ? "" : "s"} missing on this page.</div>
          <p className="mt-1">Snacky OS can create the missing purchase/cash finance links without blocking the cash collection list.</p>
          {canReviewMoney ? (
            <form action={createMissingCashFinanceLinks} className="mt-3">
              <button className="btn-secondary px-3 py-2">Create missing finance links</button>
            </form>
          ) : null}
        </div>
      ) : null}

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <input type="hidden" name="pageSize" value={pageSize} />
          <select name="status" defaultValue={params.status ?? ""} className="field-input">
            <option value="">All statuses</option>
            {statusOptions.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
          </select>
          <select name="machine_id" defaultValue={params.machine_id ?? ""} className="field-input">
            <option value="">All machines</option>
            {machines?.map((machine: any) => <option key={machine.id} value={machine.id}>{formatMachineDisplayName(machine, { includeArea: true })}</option>)}
          </select>
          <select name="operator_id" defaultValue={params.operator_id ?? ""} className="field-input">
            <option value="">All operators</option>
            {operators?.map((operator: any) => <option key={operator.id} value={operator.id}>{operator.full_name}</option>)}
          </select>
          <input name="date_from" type="date" defaultValue={params.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={params.date_to ?? ""} className="field-input" />
          <label className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700">
            <input type="checkbox" name="variance_review" value="1" defaultChecked={params.variance_review === "1"} />
            Variance review
          </label>
          <div className="grid gap-2 sm:flex">
            <button className="btn-primary w-full sm:w-auto">Filter</button>
            <Link href="/cash-collections" className="btn-secondary w-full sm:w-auto">Reset</Link>
          </div>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState title="No cash collections found" body="Manual collections and route cash pickups will appear here when real cash records exist." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-4">
            <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalCounted)}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Collections on this page</div><div className="mt-2 text-2xl font-semibold text-slate-900">{activeRows.length}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Pending count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{pendingCount}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Monthly close</div><div className="mt-3"><Link href="/finance/operations" className="link-secondary">Open reconciliation</Link></div></SectionCard>
          </div>

          <MobileCardList>
            {rows.map((collection: any) => {
              const variance = collection.variance === null || collection.variance === undefined ? null : Number(collection.variance);
              const status = getCashCollectionStatus(collection.review_status, variance);
              const finance = financeByCashId.get(collection.id);

              return (
                <MobileRecordCard key={collection.id} className={status === "variance_review" ? "border-amber-200 bg-amber-50/50" : undefined}>
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="break-words text-base font-semibold text-slate-900">{formatMachineDisplayName(collection.machine ?? null, { includeArea: true })}</h2>
                      <p className="mt-1 text-xs text-slate-500">{collection.machine?.machine_code ?? "-"} - {formatDate(collection.collected_at)}</p>
                    </div>
                    <StatusBadge status={status.replaceAll("_", " ")} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MobileField label="Counted">{money(collection.actual_cash_collected)}</MobileField>
                    <MobileField label="Counted at">{formatDate(collection.counted_at)}</MobileField>
                    <MobileField label="Monthly close"><Link href="/finance/operations" className="link-secondary">Reconcile by month</Link></MobileField>
                    <MobileField label="Collected by">{collection.operator?.full_name ?? "Unassigned"}</MobileField>
                    <MobileField label="Route">{collection.route?.id ? <Link href={`/routes/${collection.route.id}`} className="link-secondary">{collection.route.route_date}</Link> : "-"}</MobileField>
                    <MobileField label="Finance">
                      {finance?.id ? <Link href={`/finance/transactions/${finance.id}`} className="link-secondary">{finance.transaction_status ?? "posted"}</Link> : collection.actual_cash_collected !== null && collection.actual_cash_collected !== undefined ? <span className="font-medium text-amber-700">Finance link missing</span> : <span className="text-slate-500">Pending count</span>}
                    </MobileField>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <Link className="btn-secondary w-full" href={`/cash-collections/${collection.id}`}>Open</Link>
                    {canReviewMoney && status !== "voided" ? <Link className="btn-secondary w-full" href={`/cash-collections/${collection.id}/edit`}>Edit</Link> : null}
                  </div>
                </MobileRecordCard>
              );
            })}
          </MobileCardList>

          <DataTable className="hidden md:block" headers={["Machine", "Route", "Collected by", "Cash removed", "Counted amount", "Counted at", "Status", "Finance", "Actions"]}>
            {rows.map((collection: any) => {
              const variance = collection.variance === null || collection.variance === undefined ? null : Number(collection.variance);
              const status = getCashCollectionStatus(collection.review_status, variance);
              const finance = financeByCashId.get(collection.id);

              return (
                <tr key={collection.id} className={status === "variance_review" ? "bg-amber-50/60" : undefined}>
                  <td>
                    <div className="font-medium text-slate-900">{formatMachineDisplayName(collection.machine ?? null, { includeArea: true })}</div>
                    <div className="text-xs text-slate-500">{collection.machine?.machine_code ?? "-"}</div>
                  </td>
                  <td>{collection.route?.id ? <Link href={`/routes/${collection.route.id}`} className="link-secondary">{collection.route.route_date}</Link> : "-"}</td>
                  <td>{collection.operator?.full_name ?? "Unassigned"}</td>
                  <td>{formatDate(collection.collected_at)}</td>
                  <td>{money(collection.actual_cash_collected)}</td>
                  <td>{formatDate(collection.counted_at)}</td>
                  <td><StatusBadge status={status.replaceAll("_", " ")} /></td>
                  <td>
                    {finance?.id ? (
                      <Link href={`/finance/transactions/${finance.id}`} className="link-secondary">{finance.transaction_status ?? "posted"}</Link>
                    ) : (
                      <span className={collection.actual_cash_collected !== null && collection.actual_cash_collected !== undefined ? "text-sm font-medium text-amber-700" : "text-sm text-slate-500"}>
                        {collection.actual_cash_collected !== null && collection.actual_cash_collected !== undefined ? "Finance link missing" : "Pending count"}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Link className="btn-secondary px-3 py-2" href={`/cash-collections/${collection.id}`}>Open</Link>
                      {canReviewMoney && status !== "voided" ? <Link className="btn-secondary px-3 py-2" href={`/cash-collections/${collection.id}/edit`}>Edit</Link> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/cash-collections" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="cash collections" />
        </div>
      )}
    </>
  );
}
