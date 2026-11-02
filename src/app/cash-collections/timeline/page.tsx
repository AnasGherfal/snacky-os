import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic="force-dynamic";
type Machine={id:string;name:string|null;machine_code:string|null;status:string|null};
type Line={machine_id:string;removal_type:string;compartments:string[]|null;
  interval_start_at:string|null;interval_end_at:string|null;expected_cash_lyd:number|null;
  expectation_status:string|null;counted_amount_lyd:number|null};
type Collection={id:string;machine_id:string|null;operator_id:string|null;route_id:string|null;
  collected_at:string;cash_bag_id:string|null;actual_cash_collected:number|null;
  counted_at:string|null;counted_by:string|null;custody_status:string;
  storage_seal_condition:string|null;count_seal_condition:string|null;
  storage_received_at:string|null;vms_expected_cash:number|null;expected_source:string|null;
  voided_at:string|null;cash_collection_machines:Line[]|null};
type Receipt={route_stop_id:string;route_id:string;collection_id:string|null;
  machine_id:string;operator_id:string;created_at:string;state:string;bag_id:string|null;
  exception_reason:string|null;exception_notes:string|null};
const date=(v:string|null|undefined)=>v?
  new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",dateStyle:"short",timeStyle:"short"}).format(new Date(v)):"—";
const lyd=(n:number|string|null|undefined)=>n==null?"—":
  `${Number(n).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})} د.ل`;
function currentTripoliMonth(){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit"}).formatToParts(new Date());
  return `${parts.find(p=>p.type==="year")?.value??"2026"}-${parts.find(p=>p.type==="month")?.value??"11"}`;
}
function statusText(c:Collection){
  if(c.voided_at)return "ملغى — يحتاج تحقيق";
  if(c.custody_status==="removed")return "مع المحصل — لم يُودع";
  if(c.custody_status==="in_storage")return "أُبلغ عن إيداعه — لم يُعد";
  if(["counted","reconciled"].includes(c.custody_status))return "معدود فعلياً";
  return "غير مكتمل";
}
function isVerifiedPreviousFull(c:Collection,line:Line){
  return line.removal_type==="full"&&
    Boolean(c.actual_cash_collected!=null&&c.counted_at&&c.counted_by&&
      c.counted_by!==c.operator_id&&
      ["counted","reconciled"].includes(c.custody_status)&&
      c.storage_seal_condition==="intact"&&c.count_seal_condition==="intact"&&
      !c.voided_at);
}
async function readPaged<T>(
  make:(offset:number,last:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>,
  size=500,maximum=4000,
):Promise<{rows:T[];truncated:boolean;error:string|null}>{
  const rows:T[]=[];
  for(let offset=0;offset<maximum;offset+=size){
    const result=await make(offset,offset+size-1);
    if(result.error)return {rows:[],truncated:false,error:result.error.message};
    const list=result.data??[];
    rows.push(...list);
    if(list.length<size)return {rows,truncated:false,error:null};
  }
  return {rows,truncated:true,error:null};
}

export default async function MachineCashTimeline({
  searchParams,
}:{searchParams:Promise<{machine?:string;month?:string}>}){
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!isOwnerAdminRole(profile))redirect("/unauthorized");
  const db=getSupabaseAdminClient();
  if(!db)return <p className="p-4">قاعدة البيانات غير متاحة.</p>;
  const params=await searchParams;
  const machine=String(params.machine??"").trim();
  const month=/^20\d{2}-(0[1-9]|1[0-2])$/.test(params.month??"")?params.month!:currentTripoliMonth();
  const monthStart=new Date(`${month}-01T00:00:00+02:00`);
  const [year,monthNum]=month.split("-").map(Number);
  const monthEnd=new Date(Date.UTC(year,monthNum,1)-2*3600*1000);
  const lookback=new Date(monthStart.getTime()-180*86400000);
  const machinesQuery=await db.from("machines")
    .select("id,name,machine_code,status").order("name");
  if(machinesQuery.error)return <p className="p-4">تعذر تحميل الماكينات.</p>;
  const machines=machinesQuery.data as Machine[];
  const selected=machines.some(m=>m.id===machine)?machine:"";
  const startIso=lookback.toISOString(),endIso=monthEnd.toISOString();
  const [cashResponse,receiptResponse,latestXy]=await Promise.all([
    readPaged<Collection>((a,b)=>{
      let query=db.from("cash_collections")
        .select("id,machine_id,operator_id,route_id,collected_at,cash_bag_id,actual_cash_collected,counted_at,counted_by,custody_status,storage_seal_condition,count_seal_condition,storage_received_at,vms_expected_cash,expected_source,voided_at,cash_collection_machines(machine_id,removal_type,compartments,interval_start_at,interval_end_at,expected_cash_lyd,expectation_status,counted_amount_lyd)")
        .gte("collected_at",startIso).lt("collected_at",endIso)
        .order("collected_at",{ascending:true}).range(a,b);
      if(selected)query=query.eq("machine_id",selected);
      return query;
    }),
    readPaged<Receipt>((a,b)=>{
      let query=db.from("route_stop_cash_receipts")
        .select("route_stop_id,route_id,collection_id,machine_id,operator_id,created_at,state,bag_id,exception_reason,exception_notes")
        .gte("created_at",startIso).lt("created_at",endIso).order("created_at",{ascending:true}).range(a,b);
      if(selected)query=query.eq("machine_id",selected);
      return query;
    }),
    db.from("vms_transactions_raw").select("payment_time,delivery_time")
      .order("payment_time",{ascending:false,nullsFirst:false}).limit(1).maybeSingle(),
  ]);
  if(cashResponse.error||receiptResponse.error)
    return <section className="p-4 text-rose-900">تعذر تحميل بيانات النقدية بدقة، ولا يمكن إعداد تقرير موثوق الآن.</section>;
  const receiptByCollection=new Map(receiptResponse.rows.filter(r=>r.collection_id).map(r=>[r.collection_id!,r]));
  const activeCash=cashResponse.rows.filter(c=>receiptByCollection.has(c.id));
  const people=[...new Set(activeCash.map(c=>c.operator_id).filter((v):v is string=>Boolean(v)))];
  const peopleResult=people.length?await db.from("team_members").select("id,full_name").in("id",people)
    :{data:[],error:null};
  const peopleNames=new Map((peopleResult.data??[]).map(p=>[p.id,p.full_name]));
  const names=new Map(machines.map(m=>[m.id,m.name||m.machine_code||"ماكينة"]));
  const byMachine=new Map<string,Collection[]>();
  for(const c of activeCash){
    const machineId=c.machine_id??receiptByCollection.get(c.id)?.machine_id;
    if(!machineId)continue;
    const group=byMachine.get(machineId)??[];
    group.push(c);byMachine.set(machineId,group);
  }
  type Entry={c:Collection;line:Line|null;receipt:Receipt;
    start:string|null;startState:string;partialSinceBaseline:boolean;
    expected:number|null;variance:number|null;periodVerified:boolean};
  const entries:Entry[]=[];
  for(const [machineId,rows] of byMachine){
    let priorFull:Collection|null=null;
    let priorFullLine:Line|null=null;
    let partialSinceLastFull=false;
    for(const c of rows.sort((a,b)=>Date.parse(a.collected_at)-Date.parse(b.collected_at))){
      const line=c.cash_collection_machines?.find(l=>l.machine_id===machineId)??null;
      const receipt=receiptByCollection.get(c.id);
      if(!receipt||!line)continue;
      const start=priorFull&&priorFullLine&&isVerifiedPreviousFull(priorFull,priorFullLine)&&!partialSinceLastFull
        ?priorFull.collected_at:null;
      const startState=start?"verified":
        priorFull?"آخر سحب كامل لم يُتحقق من عده أو حالة ختمه":"لا يوجد سحب سابق مؤكد كخط أساس";
      const periodVerified=Boolean(start&&line.removal_type==="full"&&
        !partialSinceLastFull&&line.compartments?.includes("notes")&&line.compartments?.includes("coins"));
      const counted=Number(c.actual_cash_collected??NaN);
      const expected=periodVerified&&c.expected_source==="vms_exact"&&c.vms_expected_cash!=null
        ?Number(c.vms_expected_cash):null;
      const variance=expected!=null&&Number.isFinite(counted)?Number((counted-expected).toFixed(2)):null;
      if(Date.parse(c.collected_at)>=monthStart.getTime()){
        entries.push({c,line,receipt,start,startState,partialSinceBaseline:partialSinceLastFull,
          periodVerified,expected,variance});
      }
      if(line.removal_type==="full"&&!c.voided_at){priorFull=c;priorFullLine=line;partialSinceLastFull=false;}
      else if(line.removal_type==="partial"&&!c.voided_at){partialSinceLastFull=true;}
    }
  }
  const exceptions=receiptResponse.rows.filter(r=>r.state==="exception"&&Date.parse(r.created_at)>=monthStart.getTime());
  const latest=latestXy.data?.payment_time??latestXy.data?.delivery_time??null;
  const importCurrent=Boolean(latest&&Date.parse(latest)>=monthStart.getTime());
  entries.sort((a,b)=>Date.parse(b.c.collected_at)-Date.parse(a.c.collected_at));
  const totals={
    collected:entries.length,
    awaitingDeposit:entries.filter(e=>e.c.custody_status==="removed").length,
    waitingCount:entries.filter(e=>e.c.custody_status==="in_storage").length,
    counted:entries.filter(e=>e.c.actual_cash_collected!=null&&e.c.counted_at).length,
    flagged:entries.filter(e=>e.variance!=null&&Math.abs(e.variance)>0.005&&importCurrent).length,
  };
  const previousMonth=new Date(Date.UTC(year,monthNum-2,1)).toISOString().slice(0,7);
  const nextMonth=new Date(Date.UTC(year,monthNum,1)).toISOString().slice(0,7);
  return <main dir="rtl" className="mx-auto max-w-6xl space-y-5 p-4">
    <header className="space-y-2">
      <Link href="/cash-handling" className="text-sm font-semibold text-emerald-800 underline">النقدية</Link>
      <h1 className="text-2xl font-bold text-slate-950">متى سُحبت النقدية؟ — سجل فترات التحصيل</h1>
      <p className="text-sm leading-6 text-slate-600">
        كل كيس مربوط بزيارة الماكينة واسم المحصّل ووقت تسجيل السحب. الفارق المالي — إن وُجد — يخص الفترة بين آخر
        سحب كامل ومتحقَّق منه والسحب الحالي، وليس اتهاماً تلقائياً للمشغّل الذي حمل الكيس.
      </p>
    </header>
    <div className="flex flex-wrap gap-3">
      <form className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <label className="block text-xs font-semibold">الماكينة
          <select className="field-input mt-1" name="machine" defaultValue={selected}>
            <option value="">كل الماكينات</option>
            {machines.map(m=><option value={m.id} key={m.id}>{m.name||m.machine_code}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold">الشهر
          <input className="field-input mt-1" type="month" name="month" defaultValue={month}/>
        </label>
        <button type="submit" className="btn-primary self-end">تطبيق</button>
      </form>
      <Link className="btn-secondary self-center" href={`/cash-collections/timeline?month=${previousMonth}&machine=${selected}`}>الشهر السابق</Link>
      <Link className="btn-secondary self-center" href={`/cash-collections/timeline?month=${nextMonth}&machine=${selected}`}>الشهر التالي</Link>
    </div>
    {!importCurrent?<div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-950">
      ⚠️ لا توجد معاملات XY النقدية التفصيلية المؤكدة لهذا الشهر في قاعدة البيانات. آخر معاملة مفصلة:
      {" "}<bdi>{date(latest)}</bdi>. لا يمكن اعتبار أي نقص مالياً مثبتاً من الإجماليات الشهرية.
    </div>:null}
    {(cashResponse.truncated||receiptResponse.truncated)?<div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-900">
      عدد السجلات تجاوز حد القراءة الموثوقة لهذا التقرير. اختر ماكينة محددة أو فترة أصغر قبل اعتماد التقرير.
    </div>:null}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {[
        ["سحوبات موثقة",totals.collected],
        ["أكياس مع المشغّل",totals.awaitingDeposit],
        ["لم تُعدّ بعد",totals.waitingCount],
        ["تم عدّها",totals.counted],
        ["فروقات XY قيد المراجعة",totals.flagged],
      ].map(([label,n])=><div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-600">{label}</p>
        <p className="mt-1 text-xl font-bold">{n}</p>
      </div>)}
    </div>
    {exceptions.length>0?<section className="rounded-xl border border-rose-200 bg-rose-50 p-4">
      <h2 className="font-bold text-rose-950">سحوبات متعذرة تحتاج مراجعة ({exceptions.length})</h2>
      {exceptions.map(r=><p key={r.route_stop_id} className="mt-2 text-sm text-rose-900">
        {names.get(r.machine_id)??"ماكينة"} · <bdi>{date(r.created_at)}</bdi> · {r.exception_notes}
        {" "}<Link className="underline" href={`/routes/${r.route_id}#route-cash`}>زيارة الجولة</Link>
      </p>)}
    </section>:null}
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-slate-950">سجل أكياس هذا الشهر ({entries.length})</h2>
      {!entries.length?<p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        لا توجد سحوبات نقدية جديدة مرتبطة بتعبئة الماكينات خلال هذا الشهر.
      </p>:null}
      {entries.map(e=><article key={e.c.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-950">{names.get(e.c.machine_id??e.receipt.machine_id)??"ماكينة"} ·
              {" "}<bdi className="font-mono">{e.c.cash_bag_id??e.receipt.bag_id}</bdi></h3>
            <p className="mt-1 text-sm text-slate-700">المحصّل: {peopleNames.get(e.c.operator_id??"")??"موظف مسجّل"} ·
              {" "}<bdi>{date(e.c.collected_at)}</bdi></p>
            <p className="mt-1 text-sm text-slate-600">العهدة: {statusText(e.c)}</p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-semibold">
            <Link href={`/routes/${e.receipt.route_id}#route-cash`} className="text-emerald-800 underline">الجولة</Link>
            <Link href={`/cash-collections/${e.c.id}`} className="text-emerald-800 underline">الكيس وصورته</Link>
            <Link href={`/cash-handling?id=${e.c.id}`} className="text-emerald-800 underline">سلسلة العهدة</Link>
          </div>
        </div>
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3">
          <div><p className="text-xs text-slate-500">بداية فترة النقدية</p>
            <p className="mt-1 text-sm font-semibold">{e.start?date(e.start):"غير محددة بعد"}</p>
            {!e.start?<p className="mt-1 text-xs text-amber-800">{e.startState}</p>:null}
          </div>
          <div><p className="text-xs text-slate-500">نهاية الفترة (سحب الكيس الحالي)</p>
            <p className="mt-1 text-sm font-semibold">{date(e.c.collected_at)}</p></div>
          <div><p className="text-xs text-slate-500">العدّ الفعلي</p>
            <p className="mt-1 text-sm font-semibold">{e.c.counted_at&&e.c.actual_cash_collected!=null?lyd(e.c.actual_cash_collected):"بانتظار العد"}</p></div>
        </div>
        <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
          {e.line?.removal_type==="partial"||e.partialSinceBaseline?
            <p className="font-semibold text-amber-950">سحب جزئي أو نقدية متروكة بالماكينة — لا يمكن مطابقة فترة نظيفة قبل مراجعتها.</p>:
          e.expected!=null&&e.variance!=null&&importCurrent?
            <p className="font-semibold text-slate-950">مبيعات XY النقدية المسجلة: {lyd(e.expected)} · المعدود: {lyd(e.c.actual_cash_collected)}
              {" "}· الفرق: {lyd(e.variance)} (يحتاج التأكد من اكتمال بيانات XY)</p>:
            <p className="font-semibold text-amber-950">مقارنة XY غير مؤكدة. احتفظ بفترة السحب والكيس والمبلغ المعدود دون اختلاق نقص.</p>}
        </div>
      </article>)}
    </section>
    <p className="text-xs leading-6 text-slate-600">
      الفترة لا تثبت بمجرّد الضغط على تسجيل السحب. يجب التأكد من إفراغ الصناديق المطلوبة،
      ومن استلام الكيس وسلامة الختم والعدّ المستقل، مع اكتمال معاملات XY النقدية الدقيقة للفترة.
    </p>
  </main>;
}
