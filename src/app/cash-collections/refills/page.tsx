import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type CashRow = {
  route_stop_id: string;
  route_id: string;
  machine_id: string;
  operator_id: string;
  state: string;
  bag_id: string | null;
  collection_id: string | null;
  exception_reason: string | null;
  exception_notes: string | null;
  created_at: string;
};

const states: Record<string, string> = {
  collected: "تم تسجيل السحب",
  pending: "سحب غير مؤكد — يحتاج متابعة",
  exception: "تعذر السحب — يحتاج مراجعة",
};
const reasons: Record<string, string> = {
  unsafe: "سبب أمني",
  machine_offline: "عطل أو انقطاع الكهرباء",
  cash_access_blocked: "تعذر فتح النقدية",
  other: "سبب آخر",
};
const date = (value: string) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Tripoli", dateStyle: "short", timeStyle: "short",
}).format(new Date(value));

export default async function RefillCashAuditPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) return <p>تعذر الاتصال بقاعدة البيانات.</p>;

  const [receipts, policy] = await Promise.all([
    db.from("route_stop_cash_receipts")
      .select("route_stop_id,route_id,machine_id,operator_id,state,bag_id,collection_id,exception_reason,exception_notes,created_at")
      .order("created_at", { ascending: false }).limit(100),
    db.from("cash_refill_policy").select("enabled,pilot_machine_ids").eq("id", 1).maybeSingle(),
  ]);
  if (receipts.error || policy.error) return <p>تعذر تحميل سجل النقدية. يرجى إعادة المحاولة.</p>;

  const rows = (receipts.data ?? []) as CashRow[];
  const machines = [...new Set(rows.map(row => row.machine_id))];
  const people = [...new Set(rows.map(row => row.operator_id))];
  const [machineData, peopleData] = await Promise.all([
    machines.length ? db.from("machines").select("id,name").in("id",machines)
      : Promise.resolve({ data: [], error: null }),
    people.length ? db.from("team_members").select("id,full_name").in("id",people)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (machineData.error || peopleData.error) return <p>تعذر تحميل أسماء الماكينات والمشغلين.</p>;
  const machineNames = new Map((machineData.data ?? []).map(row => [row.id, row.name]));
  const operatorNames = new Map((peopleData.data ?? []).map(row => [row.id, row.full_name]));
  const totalPending = rows.filter(row => row.state === "pending").length;
  const totalExceptions = rows.filter(row => row.state === "exception").length;

  return (
    <main dir="rtl" className="mx-auto max-w-5xl space-y-5 p-4">
      <header className="space-y-2">
        <Link className="text-sm font-semibold text-emerald-800" href="/cash-handling">النقدية</Link>
        <h1 className="text-2xl font-bold text-slate-950">سجل النقدية مع التعبئة</h1>
        <p className="text-sm text-slate-600">
          آخر 100 عملية مسجلة في مرحلة التجربة. يظهر سحب النقدية والتعذر والسحب غير المؤكد، دون افتراض أي مبالغ مفقودة.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">عمليات مسجلة</p>
          <p className="mt-1 text-2xl font-bold">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-800">تحتاج تأكيد الحفظ</p>
          <p className="mt-1 text-2xl font-bold">{totalPending}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-xs text-rose-800">تعذر السحب</p>
          <p className="mt-1 text-2xl font-bold">{totalExceptions}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-sm font-semibold">
        <Link className="text-emerald-800 underline" href="/cash-collections/pilot">إعدادات التجربة</Link>
        <Link className="text-emerald-800 underline" href="/cash-handling">تسليم وعدّ الأكياس</Link>
        <Link className="text-emerald-800 underline" href="/cash-collections?status=counted">مطابقة XY</Link>
      </div>
      <section className="space-y-3">
        {!rows.length ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            لا توجد سحوبات مرتبطة بالتعبئة بعد. {policy.data?.enabled ? "سجّل أول ماكينة للتجربة." : "تجربة سحب النقدية غير مفعّلة حتى الآن."}
          </div>
        ) : rows.map(row => (
          <article key={row.route_stop_id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-950">{machineNames.get(row.machine_id) ?? "ماكينة غير معروفة"}</h2>
                <p className="text-sm text-slate-600">{operatorNames.get(row.operator_id) ?? "مشغّل غير معروف"} · <bdi>{date(row.created_at)}</bdi></p>
              </div>
              <span className={row.state === "collected"
                ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900"
                : "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900"}>
                {states[row.state] ?? row.state}
              </span>
            </div>
            {row.bag_id ? <p className="mt-2 text-sm">رقم الكيس: <bdi className="font-mono font-bold">{row.bag_id}</bdi></p> : null}
            {row.exception_reason ? <p className="mt-2 text-sm text-rose-800">{reasons[row.exception_reason] ?? row.exception_reason}: {row.exception_notes ?? ""}</p> : null}
            {row.collection_id ? <Link href={`/cash-handling?id=${row.collection_id}`}
              className="mt-3 inline-block text-sm font-semibold text-emerald-800 underline">عرض الكيس وحالة العهدة</Link> : null}
            {row.state === "pending" ? <p className="mt-2 text-xs text-amber-900">
              لا تعتبر هذه العملية سحباً مؤكداً، ويجب مراجعة المشغل قبل إنشاء سجل جديد.
            </p> : null}
          </article>
        ))}
      </section>
    </main>
  );
}
