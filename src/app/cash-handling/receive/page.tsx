import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { CashReceiveWorkspace } from "@/components/cash/CashReceiveWorkspace";

export const dynamic = "force-dynamic";

function countedTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tripoli", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
}

export default async function ReceiveCashPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) return <CashReceiveWorkspace defaultSafeLabel="Safe A" />;

  // This is a separate history, never an invitation to count again.
  // Show recent completed physical counts after they leave the open-box queue.
  const [policy, recentResult] = await Promise.all([
    db.from("cash_refill_policy").select("safe_label").eq("id", 1).maybeSingle(),
    db.from("cash_collections")
      .select("id, cash_bag_id, counted_at, actual_cash_collected, machine:machines(name)")
      .is("voided_at", null)
      .not("counted_at", "is", null)
      .not("actual_cash_collected", "is", null)
      .order("counted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10),
  ]);
  const rows = recentResult.error ? [] : recentResult.data ?? [];

  return (
    <div className="space-y-5">
      <CashReceiveWorkspace defaultSafeLabel={policy.data?.safe_label?.trim() || "Safe A"} />
      <section className="mx-auto max-w-3xl rounded-xl border border-emerald-200 bg-emerald-50/70 p-4" data-testid="recent-physical-cash-counts">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-emerald-950">آخر المبالغ المعدودة والمحفوظة</h2>
            <p className="mt-1 text-xs text-emerald-900">هذه مبالغ تم عدّها بالفعل، وليست أكياساً تحتاج إعادة العد. الترتيب حسب وقت تسجيل العد.</p>
          </div>
          <Link href="/finance/transactions?kind=cash_collection&sort=entered" className="text-sm font-semibold text-emerald-800 underline">عرض الحركات المالية</Link>
        </div>
        {recentResult.error ? (
          <p role="alert" className="mt-3 text-sm text-rose-800">تعذر تحميل سجل العد الأخير. السجلات لم تُحذف؛ افتح سجل النقدية وأعد المحاولة.</p>
        ) : rows.length ? (
          <div className="mt-3 space-y-2">
            {rows.map((row) => {
              const machine = Array.isArray(row.machine) ? row.machine[0] : row.machine;
              return <Link key={row.id} href={`/cash-collections/${row.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-white p-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{machine?.name || "كيس نقدية"}</span>
                  <span className="block text-xs text-slate-600">{countedTime(row.counted_at)} · {row.cash_bag_id || row.id.slice(0, 8)}</span>
                </span>
                <strong dir="ltr" className="text-base text-emerald-900">{Number(row.actual_cash_collected).toLocaleString("en-US", { maximumFractionDigits: 2 })} LYD</strong>
              </Link>;
            })}
          </div>
        ) : <p className="mt-3 text-sm text-slate-700">لا توجد مبالغ معدودة مسجلة حتى الآن.</p>}
      </section>
    </div>
  );
}
