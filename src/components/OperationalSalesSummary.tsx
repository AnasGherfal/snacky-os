import Link from "next/link";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatInteger } from "@/lib/kpi";

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export async function OperationalSalesSummary(props: { dateFrom: string; dateTo: string; vmsRevenue: number; vmsUnits: number }) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("route_manual_sales")
    .select("quantity, total_amount_lyd, payment_method, inventory_movement_id, status")
    .eq("status", "confirmed")
    .gte("sale_time", `${props.dateFrom}T00:00:00`)
    .lt("sale_time", `${nextDate(props.dateTo)}T00:00:00`)
    .limit(10000);
  if (error) {
    console.warn("[sales] Route sales summary could not load", error);
    return null;
  }
  const rows = data ?? [];
  const enteredUnits = rows.reduce((sum, row) => sum + numberValue(row.quantity), 0);
  const enteredRevenue = rows.reduce((sum, row) => sum + numberValue(row.total_amount_lyd), 0);
  const cashRevenue = rows.filter((row) => row.payment_method === "cash").reduce((sum, row) => sum + numberValue(row.total_amount_lyd), 0);
  const stockWarnings = rows.filter((row) => !row.inventory_movement_id).length;

  return (
    <section className="surface-card">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">Total operational sales</h2>
          <p className="mt-1 text-sm text-slate-500">VMS sales plus confirmed sales entered during routes. Both sources remain visible for audit.</p>
        </div>
        <Link href="/reports/route-product-activity" className="btn-secondary">Open product activity</Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">VMS sales</div><div className="mt-2 text-2xl font-semibold">{lyd(props.vmsRevenue)}</div><div className="mt-1 text-xs text-slate-500">{formatInteger(props.vmsUnits)} units</div></div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="text-xs font-semibold uppercase tracking-wide text-sky-700">Route-entered sales</div><div className="mt-2 text-2xl font-semibold text-sky-950">{lyd(enteredRevenue)}</div><div className="mt-1 text-xs text-sky-800">{formatInteger(enteredUnits)} units · cash {lyd(cashRevenue)}</div></div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:col-span-2"><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Combined total sales</div><div className="mt-2 text-3xl font-semibold text-emerald-950">{lyd(props.vmsRevenue + enteredRevenue)}</div><div className="mt-1 text-xs text-emerald-800">{formatInteger(props.vmsUnits + enteredUnits)} total units</div></div>
        <div className={stockWarnings ? "rounded-xl border border-amber-200 bg-amber-50 p-4" : "rounded-xl border border-slate-200 bg-slate-50 p-4"}><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stock posting</div><div className="mt-2 text-2xl font-semibold">{stockWarnings ? `${stockWarnings} review` : "All posted"}</div><div className="mt-1 text-xs text-slate-500">Route sales without a stock movement</div></div>
      </div>
    </section>
  );
}
