import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { canAccessOperatorRoute, isOwnerAdminRole } from "@/lib/authz";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

type Stop={id:string;machine_id:string;status:string;stop_order:number;completed_at:string|null};
type Receipt={
  route_stop_id:string;route_id:string;machine_id:string;operator_id:string;
  state:string;bag_id:string|null;collection_id:string|null;
  exception_reason:string|null;exception_notes:string|null;created_at:string;
};
type Collection={
  id:string;route_id:string|null;machine_id:string|null;operator_id:string|null;
  collected_at:string;cash_bag_id:string|null;custody_status:string|null;
  actual_cash_collected:number|null;counted_at:string|null;counted_by:string|null;
  storage_received_at:string|null;storage_seal_condition:string|null;count_seal_condition:string|null;
  vms_expected_cash:number|null;expected_source:string|null;voided_at:string|null;
};
type Closure={
  closure_status:string;counted_bags:number;exception_stops:number;
  closed_at:string;total_counted_lyd:number;owner_note:string|null;
};
function date(value:string|null|undefined) {
  if(!value)return "—";
  return new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",dateStyle:"short",timeStyle:"short"}).format(new Date(value));
}
function amount(value:number|string|null|undefined) {
  const n=Number(value??NaN);
  return Number.isFinite(n)?`${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})} د.ل`:"—";
}

async function closeRouteCash(formData:FormData) {
  "use server";
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
  const id=String(formData.get("route_id")??"");
  if(!/^[0-9a-f-]{36}$/i.test(id))redirect("/routes");
  const note=String(formData.get("owner_note")??"").trim();
  const db=await getAuthenticatedSupabaseServerClient();
  if(!db)redirect(`/routes/${id}?error=${encodeURIComponent("Cash close unavailable. Retry later.")}`);
  const result=await db.rpc("snacky_close_route_cash_v1",{p_route_id:id,p_owner_note:note||null});
  if(result.error) {
    const message=result.error.code==="22023"?
      "Explain exceptions in the owner note before cash close.":
      "Cash route not closable: every selected machine must have a saved collection or exception; every sealed bag must be independently received, counted and intact.";
    redirect(`/routes/${id}?error=${encodeURIComponent(message)}#route-cash`);
  }
  revalidatePath(`/routes/${id}`);
  redirect(`/routes/${id}?success=${encodeURIComponent("Physical cash custody closed. XY comparison remains separate.")}#route-cash`);
}

/** Server-side route view: uses only actual receipt, custody and count records. */
export async function RouteCashPanel({routeId,routeStatus,forOperator=false,allowOwnerClose=false}:{
  routeId:string;routeStatus:string;forOperator?:boolean;allowOwnerClose?:boolean;
}) {
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!profile.team_member_id)return null;
  const auth=await getAuthenticatedSupabaseServerClient();
  const admin=getSupabaseAdminClient();
  if(!auth||!admin)return <div className="rounded-xl bg-rose-50 p-4 text-rose-800">تعذر تحميل سجل نقدية الجولة.</div>;
  const routeResult=await auth.from("routes").select("id,operator_id,status").eq("id",routeId).maybeSingle();
  if(routeResult.error||!routeResult.data)return null;
  const access=await buildOperatorRouteAccessContext(auth,profile);
  if(!canAccessOperatorRoute(access,routeResult.data.operator_id))return null;
  const owner=isOwnerAdminRole(profile);
  const [stopQuery,receiptQuery,policyQuery,closureQuery]=await Promise.all([
    admin.from("route_stops").select("id,machine_id,status,stop_order,completed_at").eq("route_id",routeId).order("stop_order"),
    admin.from("route_stop_cash_receipts")
      .select("route_stop_id,route_id,machine_id,operator_id,state,bag_id,collection_id,exception_reason,exception_notes,created_at")
      .eq("route_id",routeId),
    admin.from("cash_refill_policy").select("enabled,pilot_machine_ids,activated_at").eq("id",1).maybeSingle(),
    owner?admin.from("cash_route_closures").select("closure_status,counted_bags,exception_stops,closed_at,total_counted_lyd,owner_note").eq("route_id",routeId).maybeSingle()
      :Promise.resolve({data:null,error:null}),
  ]);
  if(stopQuery.error||receiptQuery.error||policyQuery.error||closureQuery.error)
    return <section id="route-cash" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">تعذر تحميل السحوبات المرتبطة بالجولة. لا تعتبر النقدية مغلقة قبل إعادة التحقق.</section>;
  const stops=(stopQuery.data??[]) as Stop[],receipts=(receiptQuery.data??[]) as Receipt[];
  const selected=new Set<string>(policyQuery.data?.enabled?policyQuery.data?.pilot_machine_ids??[]:[]);
  const activePilot=Boolean(policyQuery.data?.enabled)&&selected.size>0;
  const activationMs=policyQuery.data?.activated_at?Date.parse(policyQuery.data.activated_at):Infinity;
  const pilotStop=(s:Stop)=>activePilot&&selected.has(s.machine_id)&&
    (s.status!=="completed"||(Boolean(s.completed_at)&&Date.parse(s.completed_at!)>=activationMs));
  const displayedStops=stops.filter(s=>pilotStop(s)||receipts.some(r=>r.route_stop_id===s.id));
  const ids=receipts.map(r=>r.collection_id).filter((x):x is string=>Boolean(x));
  const machineIds=[...new Set(displayedStops.map(s=>s.machine_id))];
  const peopleIds=[...new Set(receipts.map(r=>r.operator_id))];
  const [collectionsQuery,machinesQuery,peopleQuery]=await Promise.all([
    ids.length?admin.from("cash_collections")
      .select("id,route_id,machine_id,operator_id,collected_at,cash_bag_id,custody_status,actual_cash_collected,counted_at,counted_by,storage_received_at,storage_seal_condition,count_seal_condition,vms_expected_cash,expected_source,voided_at")
      .in("id",ids):Promise.resolve({data:[],error:null}),
    machineIds.length?admin.from("machines").select("id,name,machine_code").in("id",machineIds):Promise.resolve({data:[],error:null}),
    peopleIds.length?admin.from("team_members").select("id,full_name").in("id",peopleIds):Promise.resolve({data:[],error:null}),
  ]);
  if(collectionsQuery.error||machinesQuery.error||peopleQuery.error)
    return <section id="route-cash" className="rounded-xl border border-rose-300 bg-rose-50 p-4">تعذر تحميل حالة الأكياس. راجع النقدية قبل الإغلاق.</section>;
  const cash=new Map(((collectionsQuery.data??[]) as Collection[]).map(c=>[c.id,c]));
  const machineNames=new Map((machinesQuery.data??[]).map(m=>[m.id,m.name||m.machine_code]));
  const peopleNames=new Map((peopleQuery.data??[]).map(p=>[p.id,p.full_name]));
  const byStop=new Map(receipts.map(r=>[r.route_stop_id,r]));
  const rows=displayedStops.map(stop=>{
    const receipt=byStop.get(stop.id)??null;
    const collection=receipt?.collection_id?cash.get(receipt.collection_id)??null:null;
    const full=collection?.custody_status==="counted"||collection?.custody_status==="reconciled";
    const unmatched=Boolean(receipt?.state==="collected"&&!collection);
    const pending=receipt?.state==="pending";
    const exception=receipt?.state==="exception";
    const removed=receipt?.state==="collected"&&collection?.custody_status==="removed";
    const deposited=receipt?.state==="collected"&&collection?.custody_status==="in_storage";
    const settled=receipt?.state==="collected"&&full&&!collection?.voided_at;
    const missing=pilotStop(stop)&&stop.status==="completed"&&!receipt;
    const skippedUncollected=pilotStop(stop)&&["skipped","cancelled","canceled"].includes(stop.status)&&!receipt;
    const due=removed&&collection?.collected_at&&Date.now()-new Date(collection.collected_at).getTime()>24*3600000;
    const exact=Boolean(settled&&collection?.expected_source==="vms_exact"&&collection?.vms_expected_cash!==null);
    const label=skippedUncollected?"الموقع تم تخطيه — لا يوجد سحب نقدية":exception?"سحب متعذر — يحتاج متابعة":pending?"حفظ غير مؤكد":
      unmatched?"السجل النقدي غير متطابق":removed?(due?"الكيس لم يُودع منذ أكثر من 24 ساعة":"الكيس مع المشغّل — لم يُودع"):
      deposited?"إيداع مُبلغ عنه — لم يؤكده المستلم":settled?"تم العدّ — راجع سلسلة العهدة":
      missing?"سحب مفقود من سجل الجولة":stop.status==="completed"?"لم يُسجّل سحب":"الموقع لم يكتمل";
    return {stop,receipt,collection,label,exact,settled,pending,exception,removed,deposited,missing,skippedUncollected,due};
  });
  const unresolved=rows.filter(r=>r.missing||r.skippedUncollected||r.pending||r.removed||r.deposited||
    (r.receipt?.state==="collected"&&!r.settled)||r.exception).length;
  const counted=rows.filter(r=>r.settled).length;
  const needsDeposit=rows.filter(r=>r.removed).length;
  const exceptionCount=rows.filter(r=>r.exception).length;
  const closure=(closureQuery.data??null) as Closure|null;

  return <section id="route-cash" dir="rtl" className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold text-slate-950">نقدية الجولة — سجل السحب والتسليم</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">إكمال جولة التعبئة مسؤولية المشغّل بمجرد حفظ سحب النقدية أو سبب التعذّر لكل ماكينة. لا ينتظر استلام الخزنة أو عدّ المالك. الإيداع والعدّ ومطابقة XY أعمال مستقلة بعد الجولة.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={owner?"/cash-handling/receive":"/cash-handling/deposit"} className="btn-primary">{owner?"استلام وعدّ الأكياس":"إيداع الأكياس في الخزنة"}</Link>
        {owner?<><Link href="/cash-collections/refills" className="btn-secondary">مراجعة جميع السحوبات</Link><Link href="/cash-collections/timeline" className="btn-secondary">فترات السحب حسب الماكينة</Link></>:null}
        {owner&&!allowOwnerClose?<Link href={`/cash-collections/routes/${routeId}`} className="btn-secondary">ملف عهدة النقدية المستقل</Link>:null}
      </div>
    </header>
    {activePilot?
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-600">مواقع التجربة</p><b className="text-xl">{rows.length}</b></div>
        <div className="rounded-xl bg-amber-50 p-3"><p className="text-xs text-amber-900">مع المشغّل</p><b className="text-xl">{needsDeposit}</b></div>
        <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-900">تم العدّ</p><b className="text-xl">{counted}</b></div>
        <div className="rounded-xl bg-rose-50 p-3"><p className="text-xs text-rose-900">تحتاج متابعة</p><b className="text-xl">{unresolved}</b></div>
      </div>:
      <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">التسجيل الإلزامي أثناء التعبئة غير مفعّل حالياً. السحوبات المسجلة سابقاً تظهر أدناه إن وجدت.</div>}
    {routeStatus==="completed" ? <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-950">✓ انتهت جولة المشغّل. الأكياس التي لم تُودع أو تُعدّ تظل في متابعة النقدية ولا تعيد فتح الجولة أو تمنع إكمالها.</div> : null}
    {closure?<div className={closure.closure_status==="physically_verified"?
      "rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950":
      "rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"}>
      <strong>{closure.closure_status==="physically_verified"?"أُغلقت عهدة نقدية الجولة بعد الاستلام والعدّ المستقل":"أُغلقت عهدة النقدية مع وجود استثناءات موثقة"}</strong>
      <p className="mt-1">إغلاق العهدة: <bdi>{date(closure.closed_at)}</bdi> · أكياس معدودة: {closure.counted_bags} · إجمالي معدود: {amount(closure.total_counted_lyd)}</p>
      <p className="mt-1 text-xs">هذا الإغلاق لا يعني اكتمال مطابقة XY.</p>
    </div>:null}
    <div className="divide-y divide-slate-200 rounded-xl border border-slate-200">
      {!rows.length?<p className="p-4 text-sm text-slate-500">لا توجد مواقع نقدية مفعلة أو سحوبات مرتبطة بهذه الجولة.</p>:null}
      {rows.map(r=><div key={r.stop.id} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:p-4">
        <div>
          <p className="font-semibold text-slate-950">{r.stop.stop_order}. {machineNames.get(r.stop.machine_id)??"ماكينة"}</p>
          <p className={r.missing||r.skippedUncollected||r.pending||r.exception||r.due?"mt-1 text-sm font-semibold text-rose-800":
            "mt-1 text-sm font-semibold text-slate-700"}>{r.label}</p>
          {r.receipt?.bag_id?<p className="mt-1 text-xs text-slate-600">رقم الكيس: <bdi className="font-mono font-semibold">{r.receipt.bag_id}</bdi></p>:null}
          {r.receipt?.state==="exception"?<p className="mt-1 text-xs text-rose-700">{r.receipt.exception_notes}</p>:null}
          {r.receipt?.state==="collected"&&r.collection?.collected_at?<p className="mt-1 text-xs text-slate-600">وقت تسجيل السحب من الجهاز: <bdi>{date(r.collection.collected_at)}</bdi></p>:null}
          {r.receipt?.operator_id?<p className="mt-1 text-xs text-slate-500">المحصّل: {peopleNames.get(r.receipt.operator_id)??"مستخدم مسجل"}</p>:null}
        </div>
        <div className="space-y-2 text-sm">
          {r.collection?.storage_received_at?<p className="text-slate-600">الإيداع المُبلغ عنه: <bdi>{date(r.collection.storage_received_at)}</bdi></p>:null}
          {r.settled?<p className="font-semibold text-emerald-900">عدّ مستقل: <bdi>{date(r.collection?.counted_at)}</bdi></p>:null}
          {owner&&r.settled?<p className="font-semibold text-slate-900">المعدود فعلياً: {amount(r.collection?.actual_cash_collected)}</p>:null}
          {owner&&r.settled?<p className={r.exact?"text-emerald-800":"text-amber-800"}>
            {r.exact?`XY معاملات نقدية للفترة: ${amount(r.collection?.vms_expected_cash)} (تُراجع الفكة والتحصيل)`:"مطابقة XY: غير مؤكدة حتى تتوفر معاملات نقدية دقيقة"}</p>:null}
          {r.collection?<Link href={`/cash-handling?id=${r.collection.id}`} className="text-sm font-semibold text-emerald-800 underline">فتح الكيس وسجل العهدة</Link>:null}
          {!r.receipt&&r.stop.status!=="completed"?<Link href={`/operator/routes/${routeId}/stops/${r.stop.id}`} className="text-sm font-semibold text-emerald-800 underline">فتح التعبئة وتسجيل السحب</Link>:null}
        </div>
      </div>)}
    </div>
    {owner&&allowOwnerClose&&!closure&&activePilot&&routeStatus==="completed"&&rows.length>0?
      <form action={closeRouteCash} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <input type="hidden" name="route_id" value={routeId}/>
        <h3 className="font-bold text-slate-900">إغلاق العهدة النقدية لهذه الجولة</h3>
        <p className="text-sm leading-6 text-slate-600">
          هذا إجراء إداري اختياري لإقفال عهدة النقدية مادياً بعد نهاية جولة التعبئة. لا يؤثر إطلاقاً في حالة الجولة نفسها. يتأكد النظام من الإيداع والاستلام المستقل والعدّ.
          لا تحتاج مطابقة XY لإغلاق العهدة الجسدية، وتبقى ظاهرة على أنها غير مؤكدة إن لم تتوفر المعاملات الدقيقة.
        </p>
        {exceptionCount>0?<label className="block space-y-2 text-sm font-semibold">
          <span>سبب الموافقة على إغلاق الجولة مع {exceptionCount} استثناءات</span>
          <textarea name="owner_note" className="field-input" rows={2} minLength={15} maxLength={1500} required/>
        </label>:null}
        <button type="submit" className="btn-primary min-h-11 disabled:opacity-50"
          disabled={unresolved>exceptionCount}>تأكيد إغلاق العهدة النقدية</button>
        {unresolved>exceptionCount?<p className="text-xs font-semibold text-amber-800">لا يمكن الإغلاق بعد: هناك أكياس لم تُستلم أو تُعدّ أو سحوبات غير مؤكدة.</p>:null}
      </form>:null}
    {!owner&&!forOperator?<p className="text-xs text-slate-600">تأكيد الإغلاق من صلاحيات الإدارة.</p>:null}
  </section>;
}
