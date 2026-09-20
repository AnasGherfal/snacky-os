import { redirect } from "next/navigation";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

type ExpiryRow = {
  batch_id: string;
  product_id: string;
  product_name: string;
  sku: string | null;
  purchase_order_id: string | null;
  expiry_date: string | null;
  supplier_lot_code: string | null;
  source_kind: string;
  remaining_qty: number;
  storage_qty: number;
  operator_bag_qty: number;
  machine_qty: number;
  days_left: number | null;
  risk: string;
};

function riskRank(risk: string) {
  return ({ expired: 0, unknown: 1, "1_day": 2, "3_days": 3, "7_days": 4, "14_days": 5, "30_days": 6, safe: 7 } as Record<string, number>)[risk] ?? 8;
}

function riskLabel(row: ExpiryRow) {
  if (row.risk === "unknown") return "EXPIRY UNKNOWN";
  if (row.risk === "expired") return "EXPIRED";
  if (row.days_left === 1) return "1 day left";
  if (row.days_left !== null && row.days_left <= 30) return `${row.days_left} days left`;
  return "OK";
}

function riskStatus(row: ExpiryRow) {
  if (row.risk === "expired") return "critical";
  if (row.risk === "unknown") return "warning";
  if (row.days_left !== null && row.days_left <= 7) return "critical";
  if (row.days_left !== null && row.days_left <= 30) return "warning";
  return "confirmed";
}

export default async function ExpiryControlPage({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  const { batch = "" } = await searchParams;
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const roles = new Set([String(profile.role ?? ""), ...((profile.roles ?? []) as string[])]);
  if (![...roles].some((role) => ["owner", "admin", "supervisor", "warehouse", "purchasing"].includes(role))) {
    redirect("/unauthorized");
  }

  const accessToken = await getAuthAccessToken();
  const supabase = getSupabaseServerClient(accessToken);
  if (!supabase) {
    return <ErrorState title="Expiry control unavailable" body="Snacky OS could not connect to batch inventory. No stock is being treated as safe." />;
  }

  let query = supabase
    .from("snacky_expiry_batch_status")
    .select("batch_id, product_id, product_name, sku, purchase_order_id, expiry_date, supplier_lot_code, source_kind, remaining_qty, storage_qty, operator_bag_qty, machine_qty, days_left, risk")
    .gt("remaining_qty", 0);
  if (batch) query = query.eq("batch_id", batch);
  const { data, error } = await query.limit(1000);
  if (error) {
    console.error("[expiry-control] Could not load batch status", { error });
    return <ErrorState title="Could not verify expiry stock" body="The expiry ledger did not load. Retry before making a safety decision." action={<SecondaryButton href="/inventory/expiry">Retry</SecondaryButton>} />;
  }

  const rows = ((data ?? []) as ExpiryRow[])
    .map((row) => ({
      ...row,
      remaining_qty: Number(row.remaining_qty ?? 0),
      storage_qty: Number(row.storage_qty ?? 0),
      operator_bag_qty: Number(row.operator_bag_qty ?? 0),
      machine_qty: Number(row.machine_qty ?? 0),
      days_left: row.days_left === null ? null : Number(row.days_left),
    }))
    .sort((a, b) => riskRank(a.risk) - riskRank(b.risk) || (a.days_left ?? -9999) - (b.days_left ?? -9999) || a.product_name.localeCompare(b.product_name));

  const expired = rows.filter((row) => row.risk === "expired");
  const unknown = rows.filter((row) => row.risk === "unknown");
  const soon = rows.filter((row) => row.days_left !== null && row.days_left > 0 && row.days_left <= 30);
  const trackedUnits = rows.reduce((sum, row) => sum + row.remaining_qty, 0);

  return (
    <>
      <PageHeader
        title="Expiry Control"
        subtitle="Track each expiry batch separately across storage, operator bags, and machines. Old stock with no recorded date stays marked Unknown until physically checked."
        breadcrumbs={[
          { label: "Stock & Purchasing", href: "/inventory" },
          { label: "Expiry Control" },
        ]}
        action={<SecondaryButton href="/purchases/new">Add purchase</SecondaryButton>}
      />

      <div className="mb-6 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm leading-6 text-rose-950">
        <div className="font-semibold">Food-safety rule</div>
        <p className="mt-1">Expired stock must be removed immediately. “Expiry unknown” is not treated as safe: physically check the printed date and replace legacy stock with a tracked purchase batch.</p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="surface-card border-rose-300 bg-rose-50"><div className="text-xs font-semibold uppercase text-rose-800">Expired batches</div><div className="mt-2 text-3xl font-bold text-rose-950">{expired.length}</div></div>
        <div className="surface-card border-amber-300 bg-amber-50"><div className="text-xs font-semibold uppercase text-amber-800">Expiry unknown</div><div className="mt-2 text-3xl font-bold text-amber-950">{unknown.length}</div></div>
        <div className="surface-card border-orange-200 bg-orange-50"><div className="text-xs font-semibold uppercase text-orange-800">Due within 30 days</div><div className="mt-2 text-3xl font-bold text-orange-950">{soon.length}</div></div>
        <div className="surface-card"><div className="text-xs font-semibold uppercase text-slate-500">Tracked units</div><div className="mt-2 text-3xl font-bold text-slate-950">{trackedUnits}</div></div>
      </div>

      {!rows.length ? (
        <EmptyState title="No remaining expiry batches in this view" body={batch ? "This batch has no tracked stock left, or the link is no longer active." : "New received purchases will appear here by expiry batch."} />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <article key={row.batch_id} className={`rounded-xl border p-4 ${row.risk === "expired" ? "border-rose-300 bg-rose-50" : row.risk === "unknown" ? "border-amber-300 bg-amber-50" : row.days_left !== null && row.days_left <= 7 ? "border-orange-300 bg-orange-50" : "border-slate-200 bg-white"}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-slate-950">{row.product_name}</h2>
                    <StatusBadge status={riskStatus(row)} label={riskLabel(row)} />
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {row.expiry_date ? <>Expiry <strong>{row.expiry_date}</strong></> : <strong>Printed expiry must be checked physically</strong>}
                    {row.supplier_lot_code ? <> · Lot {row.supplier_lot_code}</> : null}
                    {row.sku ? <> · {row.sku}</> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-sm">
                    <span className="rounded-full bg-white px-3 py-1 font-semibold shadow-sm">Total {row.remaining_qty}</span>
                    <span className="rounded-full bg-white px-3 py-1">Storage {row.storage_qty}</span>
                    <span className="rounded-full bg-white px-3 py-1">Operator bags {row.operator_bag_qty}</span>
                    <span className="rounded-full bg-white px-3 py-1">Machines {row.machine_qty}</span>
                  </div>
                  {row.machine_qty > 0 ? <p className="mt-3 text-xs leading-5 text-slate-600">Machine quantity is reconciled against recent VMS stock and batch flow using FEFO. Treat it as a safety signal and physically remove/verify expired or near-expiry stock.</p> : null}
                </div>
                {row.purchase_order_id ? <SecondaryButton href={`/purchases/${row.purchase_order_id}`}>Purchase</SecondaryButton> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
