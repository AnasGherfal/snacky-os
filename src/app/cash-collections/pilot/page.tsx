import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { logActivity } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

async function updateCashPilot(formData: FormData) {
  "use server";
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) redirect("/cash-collections/pilot?error=database");
  const machineIds = Array.from(new Set(formData.getAll("machine_id").map(String)));
  const enabled = formData.get("enabled") === "on";
  if (enabled && machineIds.length < 1) redirect("/cash-collections/pilot?error=machines");
  const safe = String(formData.get("safe_label") ?? "").trim();
  if (safe.length < 2 || safe.length > 80) redirect("/cash-collections/pilot?error=safe");
  const lookup = await db.from("machines").select("id").in("id", machineIds.length ? machineIds : ["00000000-0000-0000-0000-000000000000"]);
  if (lookup.error || (lookup.data?.length ?? 0) !== machineIds.length) redirect("/cash-collections/pilot?error=machines");
  const prior = await db.from("cash_refill_policy").select("*").eq("id",1).single();
  if (prior.error) redirect("/cash-collections/pilot?error=database");
  const now=new Date().toISOString();
  const previousIds=Array.isArray(prior.data.pilot_machine_ids)?prior.data.pilot_machine_ids as string[]:[];
  const changedScope=[...previousIds].sort().join("|")!==[...machineIds].sort().join("|");
  const activatedAt=enabled&&(!prior.data.enabled||changedScope||!prior.data.activated_at)
    ? now : prior.data.activated_at??null;
  const saved = await db.from("cash_refill_policy")
    .update({ enabled, pilot_machine_ids: machineIds, safe_label: safe, activated_at: activatedAt, updated_at: now })
    .eq("id",1).select("id").maybeSingle();
  if (saved.error || !saved.data) redirect("/cash-collections/pilot?error=database");
  await logActivity({
    profile, action: "update_cash_refill_pilot", entityType: "cash_refill_policy", entityId: "1",
    beforeData: prior.data, afterData: { enabled, pilot_machine_ids: machineIds, safe_label: safe, activated_at: activatedAt },
    summary: enabled ? "Enabled mandatory refill cash pilot on selected machines" : "Paused mandatory refill cash pilot",
  });
  revalidatePath("/cash-collections/pilot");
  revalidatePath("/cash-handling");
  redirect("/cash-collections/pilot?updated=1");
}

export default async function CashRefillPilotPage({
  searchParams,
}: { searchParams: Promise<{ updated?: string; error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) return <p>تعذر الاتصال بقاعدة البيانات</p>;
  const [policyQuery, machinesQuery] = await Promise.all([
    db.from("cash_refill_policy").select("enabled,pilot_machine_ids,safe_label").eq("id",1).single(),
    db.from("machines").select("id,name,machine_code,status").eq("status","active").order("name"),
  ]);
  if (policyQuery.error || machinesQuery.error) return <p>تعذر تحميل إعدادات النقدية.</p>;
  const policy = policyQuery.data;
  const xyQuery = await db.from("vms_transactions_raw")
    .select("payment_time,delivery_time")
    .order("payment_time", { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle();
  const xyTime = xyQuery.data?.payment_time ?? xyQuery.data?.delivery_time ?? null;
  const xyAgeHours = xyTime ? (Date.now() - new Date(xyTime).getTime()) / 3600000 : Infinity;
  const xyFresh = !xyQuery.error && Number.isFinite(xyAgeHours) && xyAgeHours <= 36;
  const selected = new Set(policy?.pilot_machine_ids ?? []);
  const params = await searchParams;
  return (
    <div dir="rtl" className="mx-auto max-w-2xl space-y-6 p-4">
      <header className="space-y-2">
        <Link href="/cash-handling" className="text-sm font-semibold text-emerald-800">الرجوع إلى النقدية</Link>
        <h1 className="text-2xl font-bold text-slate-950">تفعيل سحب النقدية مع كل تعبئة</h1>
        <p className="text-sm leading-6 text-slate-600">اختر ماكينة أو ماكينتين للتجربة. باقي الماكينات تبقى بنفس النظام القديم إلى أن تتأكد من سلامة التسليم والعدّ ومطابقة XY.</p>
      </header>
      {params.updated ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">تم حفظ إعدادات التجربة.</p> : null}
      {params.error ? <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">تعذر الحفظ. تحقق من الخزنة والماكينات المختارة.</p> : null}
      <section className={xyFresh ? "rounded-xl border border-emerald-200 bg-emerald-50 p-4" : "rounded-xl border border-amber-200 bg-amber-50 p-4"}>
        <h2 className="font-bold text-slate-950">مطابقة XY</h2>
        <p className="mt-1 text-sm leading-6">
          {xyFresh ? "توجد معاملات مفصلة حديثة من XY. ستظهر المقارنة بعد العد والتحقق من الفترة."
            : "لا توجد معاملات XY حديثة مؤكدة للمقارنة النقدية. سيُحفظ سحب النقدية والعدّ، لكن الفروقات ستظل غير مؤكدة حتى تتوفر معاملات كاملة لفترة السحب."}
        </p>
        <p className="mt-2 text-xs text-slate-700">آخر معاملة في قاعدة البيانات: <bdi>{xyTime ? new Date(xyTime).toLocaleString("en-GB", { timeZone:"Africa/Tripoli" }) : "غير متوفر"}</bdi></p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link href="/vms-import" className="text-sm font-semibold text-emerald-950 underline">رفع معاملات VMS</Link>
          <Link href="/cash-collections?status=counted" className="text-sm font-semibold text-emerald-950 underline">مراجعة مطابقة النقدية</Link>
        </div>
      </section>
            <form action={updateCashPilot} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5">
        <label className="flex items-center gap-3 text-sm font-semibold">
          <input type="checkbox" name="enabled" defaultChecked={Boolean(policy?.enabled)}/>
          تفعيل شرط تسجيل النقدية قبل إنهاء التعبئة للماكينات المختارة
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          مكان الإيداع في المخزن
          <input className="field-input" name="safe_label" defaultValue={policy?.safe_label || "Safe A"} maxLength={80} required/>
        </label>
        <fieldset className="space-y-3">
          <legend className="font-semibold">ماكينات التجربة</legend>
          {(machinesQuery.data ?? []).map(machine => (
            <label key={machine.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 px-3 text-sm">
              <input type="checkbox" name="machine_id" value={machine.id} defaultChecked={selected.has(machine.id)}/>
              <span>{machine.name} <small className="text-slate-500">{machine.machine_code}</small></span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn-primary min-h-12 w-full">حفظ الإعدادات</button>
        <p className="text-xs leading-6 text-slate-500">لا يغيّر هذا الإعداد السحوبات السابقة ولا أرصدة الشركة. لا يتم تفعيل جميع الماكينات تلقائياً.</p>
      </form>
    </div>
  );
}
