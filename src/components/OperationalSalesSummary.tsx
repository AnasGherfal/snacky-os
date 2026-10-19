import Link from "next/link";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";
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
  const { locale } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  if (!supabase) return null;
  const { data, error } = await supabase.from("route_manual_sales")
    .select("quantity, total_amount_lyd, payment_method, inventory_movement_id, status, repair_task_id, cash_destination")
    .eq("status", "confirmed")
    .gte("sale_time", `${props.dateFrom}T00:00:00+02:00`)
    .lt("sale_time", `${nextDate(props.dateTo)}T00:00:00+02:00`)
    .limit(10000);
  if (error) {
    console.warn("[sales] Manual sales summary could not load", error);
    return <section role="alert" className="surface-card text-amber-900">{tr("Manual sales could not be loaded. The VMS total alone may be incomplete.", "تعذر تحميل المبيعات اليدوية. إجمالي XY وحده قد يكون غير مكتمل.")}</section>;
  }
  const rows = data ?? [];
  const enteredUnits = rows.reduce((sum, row) => sum + numberValue(row.quantity), 0);
  const enteredRevenue = rows.reduce((sum, row) => sum + numberValue(row.total_amount_lyd), 0);
  const cashRevenue = rows.filter((row) => row.payment_method === "cash").reduce((sum, row) => sum + numberValue(row.total_amount_lyd), 0);
  const repairRevenue = rows.filter((row) => row.repair_task_id && row.cash_destination === "machine_cashbox").reduce((sum, row) => sum + numberValue(row.total_amount_lyd), 0);
  const stockWarnings = rows.filter((row) => !row.inventory_movement_id).length;
  return <section className="surface-card">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 className="text-lg font-semibold text-slate-950">{tr("Total operational sales", "إجمالي المبيعات التشغيلية")}</h2>
        <p className="mt-1 text-sm text-slate-500">{tr("VMS sales plus confirmed manual sales from routes and repairs. Collecting the cash is not a second sale.", "مبيعات XY إضافة إلى المبيعات اليدوية المؤكدة أثناء الجولات والإصلاحات. جمع النقود لاحقاً ليس بيعاً جديداً.")}</p></div>
      <Link href="/reports/route-product-activity" className="btn-secondary">{tr("Open product activity", "فتح حركة المنتجات")}</Link>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="text-xs font-semibold text-slate-500">{tr("VMS sales", "مبيعات XY")}</div><div className="mt-2 text-2xl font-semibold">{lyd(props.vmsRevenue)}</div><div className="mt-1 text-xs text-slate-500">{formatInteger(props.vmsUnits)} {tr("units", "قطعة")}</div></div>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="text-xs font-semibold text-sky-700">{tr("Manual sales — routes + repairs", "بيع يدوي — جولات وإصلاحات")}</div><div className="mt-2 text-2xl font-semibold text-sky-950">{lyd(enteredRevenue)}</div><div className="mt-1 text-xs text-sky-800">{formatInteger(enteredUnits)} {tr("units · cash", "قطعة · نقد")} {lyd(cashRevenue)}</div><p className="mt-2 text-xs font-semibold text-sky-900">{tr("Repair sales / cash left in machines", "بيع الإصلاحات / نقد متروك بالماكينات")}: {lyd(repairRevenue)}</p></div>
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:col-span-2"><div className="text-xs font-semibold text-emerald-700">{tr("Combined total sales", "إجمالي المبيعات المجمّع")}</div><div className="mt-2 text-3xl font-semibold text-emerald-950">{lyd(props.vmsRevenue + enteredRevenue)}</div><div className="mt-1 text-xs text-emerald-800">{formatInteger(props.vmsUnits + enteredUnits)} {tr("total units", "إجمالي القطع")}</div></div>
      <div className={stockWarnings ? "rounded-xl border border-amber-200 bg-amber-50 p-4" : "rounded-xl border border-slate-200 bg-slate-50 p-4"}><div className="text-xs font-semibold text-slate-500">{tr("Stock posting", "تسجيل حركة المخزون")}</div><div className="mt-2 text-2xl font-semibold">{stockWarnings ? `${stockWarnings} ${tr("review", "للمراجعة")}` : tr("All posted", "تم تسجيل الكل")}</div><div className="mt-1 text-xs text-slate-500">{tr("Manual sales without a stock movement", "مبيعات يدوية دون حركة مخزون")}</div></div>
    </div>
  </section>;
}
