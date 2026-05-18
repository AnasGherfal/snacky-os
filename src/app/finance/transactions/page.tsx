import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { isBalanceAffectingTransaction, signedAmount } from "@/lib/finance-balance";
import { lyd } from "@/lib/format";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type TransactionParams = {
  q?: string;
  review?: string;
  direction?: string;
  kind?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  saved?: string;
  error?: string;
};

function canAccess(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return profile && canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status });
}

function categoryLabel(row: any) {
  return row.final_bucket ?? row.transaction_type ?? String(row.transaction_kind ?? "transaction").replaceAll("_", " ");
}

function paymentLabel(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "-";
}

function sourceLabel(row: any) {
  if (row.source_sheet) return `${row.source_sheet}:${row.source_row}`;
  if (row.related_purchase_id) return "purchase";
  if (row.related_cash_collection_id) return "cash collection";
  return "manual";
}

function relatedLabel(row: any, maps: { purchases: Map<string, any>; routes: Map<string, any>; machines: Map<string, any>; locations: Map<string, any> }) {
  const items = [];
  const purchase = row.related_purchase_id ? maps.purchases.get(row.related_purchase_id) : null;
  const route = row.related_route_id ? maps.routes.get(row.related_route_id) : null;
  const machine = row.related_machine_id ? maps.machines.get(row.related_machine_id) : null;
  const location = row.related_location_id ? maps.locations.get(row.related_location_id) : null;

  if (purchase) items.push(<Link key="purchase" href={`/purchases/${purchase.id}`} className="link-secondary">Purchase {purchase.receipt_number ?? purchase.id.slice(0, 8)}</Link>);
  if (route) items.push(<Link key="route" href={`/routes/${route.id}`} className="link-secondary">Route {route.route_date}</Link>);
  if (machine) items.push(<Link key="machine" href={`/machines/${machine.id}/edit`} className="link-secondary">{machine.machine_code ?? machine.name}</Link>);
  if (location) items.push(<Link key="location" href={`/locations/${location.id}`} className="link-secondary">{location.name}</Link>);
  if (row.related_cash_collection_id) items.push(<Link key="cash" href={`/cash-collections/${row.related_cash_collection_id}`} className="link-secondary">Cash collection</Link>);

  return items.length ? <div className="flex flex-col gap-1">{items}</div> : <span className="text-slate-400">-</span>;
}

async function fetchByIds(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>, table: string, select: string, ids: string[]) {
  if (!ids.length) return [];
  const { data } = await supabase.from(table).select(select).in("id", Array.from(new Set(ids)));
  return data ?? [];
}

export default async function FinanceTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<TransactionParams>;
}) {
  const profile = await getCurrentProfile();
  if (!canAccess(profile)) redirect("/unauthorized");
  const params = await searchParams;
  const supabase = getSupabaseServerClient();
  const statusFilter = params.status ?? "active";

  let query = supabase
    ?.from("financial_transactions")
    .select("id, transaction_date, direction, transaction_kind, transaction_type, description, notes, amount, signed_amount, final_bucket, payment_method, transaction_status, review_status, needs_review, source_sheet, source_row, related_purchase_id, related_cash_collection_id, related_route_id, related_machine_id, related_location_id, receipt_url, created_at")
    .order("transaction_date", { ascending: false })
    .limit(1000);

  if (query && statusFilter !== "all") query = query.eq("transaction_status", statusFilter);
  if (query && params.review === "needs_review") query = query.eq("needs_review", true);
  if (query && params.review === "confirmed") query = query.eq("review_status", "confirmed");
  if (query && params.review === "reviewed") query = query.eq("review_status", "reviewed");
  if (query && params.direction) query = query.eq("direction", params.direction);
  if (query && params.kind) query = query.eq("transaction_kind", params.kind);
  if (query && params.date_from) query = query.gte("transaction_date", params.date_from);
  if (query && params.date_to) query = query.lte("transaction_date", params.date_to);

  const { data } = query ? await query : { data: [] };
  const search = String(params.q ?? "").trim().toLowerCase();
  const rows = ((data ?? []) as any[]).filter((row) => {
    if (!search) return true;
    return [row.transaction_type, row.description, row.notes, row.final_bucket, row.payment_method, row.source_sheet].join(" ").toLowerCase().includes(search);
  });

  const maps = { purchases: new Map<string, any>(), routes: new Map<string, any>(), machines: new Map<string, any>(), locations: new Map<string, any>() };
  if (supabase) {
    const [purchases, routes, machines, locations] = await Promise.all([
      fetchByIds(supabase, "purchase_orders", "id, receipt_number, order_date", rows.map((row) => row.related_purchase_id).filter(Boolean)),
      fetchByIds(supabase, "routes", "id, route_date, status", rows.map((row) => row.related_route_id).filter(Boolean)),
      fetchByIds(supabase, "machines", "id, name, machine_code", rows.map((row) => row.related_machine_id).filter(Boolean)),
      fetchByIds(supabase, "locations", "id, name", rows.map((row) => row.related_location_id).filter(Boolean)),
    ]);
    purchases.forEach((row: any) => maps.purchases.set(row.id, row));
    routes.forEach((row: any) => maps.routes.set(row.id, row));
    machines.forEach((row: any) => maps.machines.set(row.id, row));
    locations.forEach((row: any) => maps.locations.set(row.id, row));
  }

  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const moneyIn = balanceRows.filter((row) => row.direction === "money_in").reduce((sum, row) => sum + signedAmount(row), 0);
  const moneyOut = Math.abs(balanceRows.filter((row) => row.direction === "money_out").reduce((sum, row) => sum + signedAmount(row), 0));
  const net = balanceRows.reduce((sum, row) => sum + signedAmount(row), 0);

  return (
    <AppShell>
      <PageHeader title="Financial Transactions" subtitle="Editable money in/out ledger. Only approved active rows affect balance." action={<PrimaryButton href="/finance/transactions/new">Add transaction</PrimaryButton>} />
      {params.error ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 shadow-lg">{params.error}</div> : null}
      {params.saved ? <div className="fixed right-5 top-5 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg">Transaction saved.</div> : null}

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card"><div className="text-sm text-slate-500">Balance-impact net</div><div className={`mt-1 text-3xl font-semibold ${net < 0 ? "text-rose-700" : "text-slate-900"}`}>{lyd(net)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Money in</div><div className="mt-1 text-3xl font-semibold">{lyd(moneyIn)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Money out</div><div className="mt-1 text-3xl font-semibold">{lyd(moneyOut)}</div></div>
        <div className="surface-card"><div className="text-sm text-slate-500">Rows shown</div><div className="mt-1 text-3xl font-semibold">{rows.length}</div></div>
      </section>

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-8">
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search description, category, method..." className="field-input xl:col-span-2" />
          <select name="status" defaultValue={statusFilter} className="field-input"><option value="active">Active</option><option value="voided">Voided</option><option value="archived">Archived</option><option value="all">All statuses</option></select>
          <select name="review" defaultValue={params.review ?? ""} className="field-input"><option value="">All review states</option><option value="needs_review">Needs review</option><option value="confirmed">Confirmed</option><option value="reviewed">Reviewed</option></select>
          <select name="direction" defaultValue={params.direction ?? ""} className="field-input"><option value="">All directions</option><option value="money_in">Money in</option><option value="money_out">Money out</option></select>
          <select name="kind" defaultValue={params.kind ?? ""} className="field-input"><option value="">All kinds</option><option value="spreadsheet_import">Spreadsheet import</option><option value="manual_money_in">Manual money in</option><option value="manual_money_out">Manual money out</option><option value="product_purchase">Product purchase</option><option value="cash_collection">Cash collection</option></select>
          <input name="date_from" type="date" defaultValue={params.date_from ?? ""} className="field-input" />
          <input name="date_to" type="date" defaultValue={params.date_to ?? ""} className="field-input" />
          <div className="flex gap-2"><button className="btn-primary">Filter</button><Link href="/finance/transactions" className="btn-secondary">Reset</Link></div>
        </form>
      </section>

      {!rows.length ? (
        <EmptyState title="No finance transactions found" body="Import historical transactions or add manual transactions to populate this ledger." />
      ) : (
        <DataTable headers={["Date", "Direction", "Category", "Amount", "Description", "Payment", "Related", "Status", "Actions"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.transaction_date}</td>
              <td><StatusBadge status={row.direction.replace("_", " ")} /></td>
              <td><div className="font-medium text-slate-900">{categoryLabel(row)}</div><div className="text-xs text-slate-500">{sourceLabel(row)}</div></td>
              <td className={`font-semibold ${Number(row.signed_amount ?? 0) < 0 ? "text-rose-700" : "text-emerald-700"}`}>{lyd(Number(row.signed_amount ?? 0))}</td>
              <td className="max-w-md">{row.description ?? row.notes ?? "-"}</td>
              <td>{paymentLabel(row.payment_method)}</td>
              <td>{relatedLabel(row, maps)}</td>
              <td><div className="flex flex-col gap-1"><StatusBadge status={row.transaction_status ?? "active"} />{row.needs_review ? <StatusBadge status="needs_review" /> : null}</div></td>
              <td><div className="flex flex-wrap gap-2"><Link href={`/finance/transactions/${row.id}`} className="btn-secondary">View</Link><Link href={`/finance/transactions/${row.id}/edit`} className="btn-secondary">{row.needs_review ? "Review" : "Edit"}</Link></div></td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
