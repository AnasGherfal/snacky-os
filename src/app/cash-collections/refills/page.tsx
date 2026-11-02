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
  const ids=rows.map(r=>r.collection_id).filter((id):id is string=>Boolean(id));
  const recentCash=ids.length ? await db.from("cash_collections")
    .select("id,collected_at,custody_status,storage_received_at,counted_at,actual_cash_collected,vms_expected_cash,expected_source")
    .in("id",ids) : {data:[],error:null};
  if(recentCash.error)return <p>تعذر جلب عهدة النقدية. يرجى المحاولة لاحقاً.</p>;
  const cashMap=new Map((recentCash.data??[]).map(c=>[c.id,c]));
  const entries=rows.map(row=>{
    const cash=row.collection_id?cashMap.get(row.collection_id)??null:null;
    const removed=row.state==="collected"&&cash?.custody_status==="removed";
    const stored=row.state==="collected"&&cash?.custody_status==="in_storage";
    const counted=row.state==="collected"&&["counted","reconciled"].includes(String(cash?.custody_status??""));
    const elapsed=Date.now()-new Date(cash?.collected_at??row.created_at).getTime();
    const overdue=Boolean(removed&&elapsed>24*3600000||stored&&elapsed>48*3600000);
    const label=row.state==="pending"?"سحب غير مؤكد":
      row.state==="exception"?"تعذر سحب النقد":
      removed?"الكيس مع المشغّل — لم يُودع":
      stored?"إيداع مُبلغ عنه — بانتظار الاستلام والعد":
      counted?"الكيس معدود":row.state==="collected"?"حالة العهدة تحتاج مراجعة":row.state;
    return {...row,cash,removed,stored,counted,overdue,label};
  }).sort((a,b)=>Number(b.overdue)-Number(a.overdue)||
    Number(b.state==="pending")-Number(a.state==="pending")||
    Number(b.state==="exception")-Number(a.state==="exception")||
    new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
  const totalPending = entries.filter(row => row.state === "pending").length;
  const totalExceptions = entries.filter(row => row.state === "exception").length;
  const awaitingDeposit=entries.filter(row=>row.removed).length;
  const awaitingReceipt=entries.filter(row=>row.stored).length;
  const overdueCount=entries.filter(row=>row.overdue).length;

  return (
    <main dir="rtl" className="mx-auto max-w-5xl space-y-5 p-4">
      <header className="space-y-2">
        <Link className="text-sm font-semibold text-emerald-800" href="/cash-handling">النقدية</Link>
        <h1 className="text-2xl font-bold text-slate-950">سجل النقدية مع التعبئة</h1>
        <p className="text-sm text-slate-600">
          آخر 100 عملية مسجلة في مرحلة التجربة. يظهر سحب النقدية والتعذر والسحب غير المؤكد، دون افتراض أي مبالغ مفقودة.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-800">بانتظار الإيداع</p>
          <p className="mt-1 text-2xl font-bold">{awaitingDeposit}</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs text-blue-800">بانتظار الاستلام والعدّ</p>
          <p className="mt-1 text-2xl font-bold">{awaitingReceipt}</p>
        </div>
      </div>
      {overdueCount > 0 ? <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-900">
        تنبيه: {overdueCount} كيس تأخر عن الإيداع أو الاستلام. راجع المشغّل وصاحب العهدة فوراً. الإيداع المذكور ليس إثباتاً أن الكيس موجود داخل الخزنة.
      </div> : null}
      <div className="flex flex-wrap gap-3 text-sm font-semibold">
        <Link className="text-emerald-800 underline" href="/cash-collections/pilot">إعدادات التجربة</Link>
        <Link className="text-emerald-800 underline" href="/cash-handling">تسليم وعدّ الأكياس</Link>
        <Link className="text-emerald-800 underline" href="/cash-handling/deposit">إيداع الأكياس</Link>
        <Link className="text-emerald-800 underline" href="/cash-handling/receive">التحقق والاستلام والعدّ</Link>
        <Link className="text-emerald-800 underline" href="/cash-collections?status=counted">مطابقة XY</Link>
      </div>
      <section className="space-y-3">
        {!rows.length ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            لا توجد سحوبات مرتبطة بالتعبئة بعد. {policy.data?.enabled ? "سجّل أول ماكينة للتجربة." : "تجربة سحب النقدية غير مفعّلة حتى الآن."}
          </div>
        ) : entries.map(row => (
          <article key={row.route_stop_id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-950">{machineNames.get(row.machine_id) ?? "ماكينة غير معروفة"}</h2>
                <p className="text-sm text-slate-600">{operatorNames.get(row.operator_id) ?? "مشغّل غير معروف"} · تم السحب وتسجيله: <bdi>{date(row.cash?.collected_at??row.created_at)}</bdi></p>
              </div>
              <span className={row.state === "collected"
                ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900"
                : "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900"}>
                {row.label}{row.overdue ? " — متأخر!" : ""}
              </span>
            </div>
            {row.bag_id ? <p className="mt-2 text-sm">رقم الكيس: <bdi className="font-mono font-bold">{row.bag_id}</bdi></p> : null}
            {row.exception_reason ? <p className="mt-2 text-sm text-rose-800">{reasons[row.exception_reason] ?? row.exception_reason}: {row.exception_notes ?? ""}</p> : null}
            {row.collection_id ? <div className="mt-3 flex flex-wrap gap-4 text-sm font-semibold">
              <Link href={`/cash-handling?id=${row.collection_id}`} className="text-emerald-800 underline">السجل والتسليم</Link>
              <Link href={`/cash-collections/${row.collection_id}`} className="text-emerald-800 underline">المراجعة وصور السحب</Link>
              {row.stored ? <Link href={`/cash-handling/receive?id=${row.collection_id}`} className="text-emerald-800 underline">استلام حقيقي من الخزنة</Link>:null}
            </div> : null}
            <Link href={`/routes/${row.route_id}#route-cash`}
              className="mt-2 inline-block text-sm font-semibold text-slate-700 underline">سجل الجولة المرتبط</Link>
            {row.counted ? <p className="mt-2 text-sm text-emerald-900">المبلغ المعدود فعلياً: <strong>{Number(row.cash?.actual_cash_collected ?? 0).toFixed(2)} د.ل</strong> · {row.cash?.expected_source==="vms_exact"?"توجد قيمة XY": "مقارنة XY غير مؤكدة"}</p> : null}
            {row.state === "pending" ? <p className="mt-2 text-xs text-amber-900">
              لا تعتبر هذه العملية سحباً مؤكداً، ويجب مراجعة المشغل قبل إنشاء سجل جديد.
            </p> : null}
          </article>
        ))}
      </section>
    </main>
  );
}
