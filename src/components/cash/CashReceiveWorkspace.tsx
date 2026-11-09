"use client";
import Link from "next/link";
import { useEffect,useMemo,useState,type FormEvent } from "react";
import { cashReceiptMatches,validateCashCommand,isUnnumberedCashReference,type CashWorkspace,type CashBox,type CashCommand } from "@/lib/cash-handover";

const fmt=(d:string)=>new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",dateStyle:"short",timeStyle:"short"}).format(new Date(d));
function monthKey(date:Date|string){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit"}).formatToParts(new Date(date));
  return `${parts.find(p=>p.type==="year")?.value}-${parts.find(p=>p.type==="month")?.value}`;
}
function requestKey(id:string,action:string){return `snacky.cash.owner-receive.v1.${id}.${action}`;}
function stored(key:string):CashCommand|null{
  try{const x=sessionStorage.getItem(key);return x?validateCashCommand(JSON.parse(x)):null;}
  catch{return null;}
}
export function CashReceiveWorkspace({defaultSafeLabel}:{defaultSafeLabel:string}) {
  const [view,setView]=useState<CashWorkspace|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [selected,setSelected]=useState<string|null>(null);
  const [showHistory,setShowHistory]=useState(false);
  const [bagId,setBagId]=useState("");
  const [noPrintedNumber,setNoPrintedNumber]=useState(false);
  const [seal,setSeal]=useState<"intact"|"broken"|"mismatch">("intact");
  const [note,setNote]=useState("");
  const [amount,setAmount]=useState("");
  const [cashLocation,setCashLocation]=useState(defaultSafeLabel);
  const [physical,setPhysical]=useState(false);
  const [reload,setReload]=useState(0);

  useEffect(()=>{
    const linked=new URLSearchParams(window.location.search).get("id");
    if(linked)setSelected(linked);
  },[]);
  useEffect(()=>{
    let ended=false;
    (async()=>{
      setLoading(true);setError("");
      try{
        let main:CashWorkspace|null=null;
        const combined:CashBox[]=[];
        for(let offset=0;offset<100;offset+=25){
          const res=await fetch(`/api/cash-handling?status=open&offset=${offset}`,{cache:"no-store"});
          const result=await res.json();
          if(!res.ok||result.ok!==true||!result.data)throw Error("تعذر تحميل الأكياس. أعد المحاولة.");
          const page=result.data as CashWorkspace;
          if(!main)main=page;combined.push(...page.rows);
          if(page.rows.length===0||combined.length>=page.total)break;
        }
        if(!ended&&main)setView({...main,rows:combined});
      }catch(e){if(!ended)setError(e instanceof Error?e.message:"تعذر التحميل.");}
      finally{if(!ended)setLoading(false);}
    })();
    return()=>{ended=true;};
  },[reload]);

  // Oldest sealed bags first: counting in pickup order keeps previous verified
  // full removals available as the baseline for later XY intervals.
  const oldestFirst=(a:CashBox,b:CashBox)=>Date.parse(a.collected_at)-Date.parse(b.collected_at);
  const visibleRows=useMemo(()=>(view?.rows??[]).filter(r=>showHistory||monthKey(r.collected_at)===monthKey(new Date())),[view,showHistory]);
  const ready=useMemo(()=>visibleRows.filter(r=>r.actions.includes("pickup")||r.actions.includes("takeover")).sort(oldestFirst),[visibleRows]);
  const toCount=useMemo(()=>visibleRows.filter(r=>r.actions.includes("count")).sort(oldestFirst),[visibleRows]);
  // A direct link to a historical bag still opens its exact record.
  const box=(view?.rows??[]).find(r=>r.id===selected)??null;
  const action=box?.actions.includes("count")?"count":box?.actions.includes("pickup")?"pickup":
    box?.actions.includes("takeover")?"takeover":null;
  const unnumbered=Boolean(box && (isUnnumberedCashReference(box.bag) || noPrintedNumber));

  function select(id:string){
    setSelected(id);setBagId("");setNoPrintedNumber(false);setSeal("intact");setNote("");setAmount("");
    setCashLocation(defaultSafeLabel);setPhysical(false);setError("");setSuccess("");
    window.history.replaceState(null,"",`/cash-handling/receive?id=${encodeURIComponent(id)}`);
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!box||!action||busy)return;
    setBusy(true);setError("");setSuccess("");
    const key=requestKey(box.id,action);
    try{
      if(!physical)throw Error("تأكد من وجود الكيس واستلامه فعلياً قبل المتابعة.");
      let payload:CashCommand["payload"];
      if(action==="count") {
        if(!/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/.test(amount.trim()))throw Error("أدخل المبلغ الحقيقي بالدينار.");
        payload={amount:amount.trim(),cash_location:cashLocation.trim()};
      } else {
        if(!unnumbered && bagId.trim().toUpperCase()!==box.bag?.trim().toUpperCase())
          throw Error("رقم الكيس لا يطابق السجل. لا تؤكد استلام كيس آخر.");
        if(!box.bag?.trim())throw Error("مرجع السحب غير موجود. لا تؤكد الاستلام.");
        if(!unnumbered && (seal!=="intact"||action==="takeover")&&note.trim().length<3)
          throw Error("اكتب تأكيد الاستلام أو اشرح مشكلة الختم.");
        payload=unnumbered
          ? {
              // Internal record reference, NOT a number on the physical bag.
              confirm_bag_id:box.bag.trim(),
              seal_condition:"mismatch",
              notes:("UNNUMBERED CASH BAG: no printed or independently verifiable seal. " +
                "I compared the actual bag with machine, collection time and removal/dropoff photos. " +
                "Owner variance review remains required. " + note.trim()).trim(),
            }
          : {confirm_bag_id:bagId.trim(),seal_condition:seal,notes:note.trim()};
      }
      let command=stored(key);
      if(!command){
        command=validateCashCommand({
          request_id:crypto.randomUUID(),collection_id:box.id,action,revision:box.revision,payload,
        });
        try{sessionStorage.setItem(key,JSON.stringify(command));}
        catch{throw Error("تعذر حفظ مرجع الطلب على الهاتف. حاول بعد تفعيل التخزين.");}
      }
      const res=await fetch("/api/cash-handling",{
        method:"POST",headers:{"content-type":"application/json"},
        cache:"no-store",body:JSON.stringify(command),signal:AbortSignal.timeout(40000),
      });
      const result=await res.json();
      if(!res.ok||!cashReceiptMatches(command,result)) {
        const retryable=result.retryable!==false;
        if(retryable)throw Error("الحفظ غير مؤكد. أعد المحاولة بنفس المرجع؛ لا تكرر استلام الكيس أو عدّه.");
        throw Error("تعذّر اعتماد الخطوة. حدّث الصفحة وتحقق من نفس سجل السحب والصورة قبل إعادة المحاولة.");
      }
      try{sessionStorage.removeItem(key);}catch{/* committed */}
      const wasCounted=action==="count";
      setSuccess(wasCounted?
        "تم تسجيل العد الفعلي للكيس؛ يُدخل المبلغ مرة واحدة في السجل المالي، وتظل التسوية منفصلة إذا كانت XY غير مؤكدة أو الكيس غير مرقم.":
        unnumbered
          ? "تم تسجيل استلام الكيس غير المرقم مع تنبيه غياب رقم الختم للمراجعة؛ افتحه وعد النقدية الفعلية."
          : `تم تأكيد استلام الكيس ${box.bag} بصفة مستقلة. افتحه وعدّ النقدية وسجّل الإجمالي.`);
      setSelected(null);setAmount("");setPhysical(false);setBagId("");setNoPrintedNumber(false);
      window.history.replaceState(null,"","/cash-handling/receive");
      setReload(n=>n+1);
    }catch(e){setError(e instanceof Error?e.message:"لم يكتمل الحفظ.")}
    finally{setBusy(false);}
  }
  return <main dir="rtl" className="mx-auto max-w-3xl space-y-5 p-4">
    <header className="space-y-2">
      <Link href="/cash-handling" className="text-sm font-semibold text-emerald-800">النقدية</Link>
      <h1 className="text-2xl font-bold text-slate-950">استلام وعدّ أكياس النقدية</h1>
      <p className="text-sm leading-6 text-slate-600">
        لا تعتمد صورة الإيداع وحدها. افتح الخزنة وتحقق من وجود الكيس فعلياً. للأكياس غير المرقمة طابق الماكينة ووقت السحب وصورة السحب والإيداع؛ لا تعتبرها مختومة برقم.
        بعد الاستلام افتح الكيس وعدّ النقدية بنفسك، ولا تستخدم XY بديلاً عن العدّ.
      </p>
    </header>
    {view?.owner ? <Link href="/cash-collections/count"
      className="block rounded-xl bg-emerald-700 p-4 text-center text-base font-bold text-white">
      عدّ النقدية بسهولة — سحوبات هذا الشهر مع صور السحب والتخزين
    </Link> : null}
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
      {showHistory ? "تعرض أيضاً السجلات القديمة للمراجعة، وليست بالضرورة نقدية معلّقة اليوم." : "تُعرض سحوبات الشهر الحالي فقط. السجلات القديمة محفوظة في الأرشيف."}
      <button type="button" className="mr-3 font-bold underline" onClick={()=>setShowHistory(v=>!v)}>
        {showHistory?"إخفاء السجلات القديمة":"عرض السجلات القديمة"}
      </button>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-sm text-amber-900">بانتظار الاستلام الفعلي</div><b className="text-2xl">{ready.length}</b></div>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4"><div className="text-sm text-sky-900">استلمت ولم تُعدّ بعد</div><b className="text-2xl">{toCount.length}</b></div>
    </div>
    {loading?<p className="rounded-xl border bg-white p-4">جارٍ تحميل سجلات الخزنة...</p>:null}
    {error?<div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-950">{error}</div>:null}
    {success?<div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-950">{success}</div>:null}
    {box&&action?<form onSubmit={submit} className="space-y-4 rounded-2xl border-2 border-emerald-300 bg-white p-5">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="text-lg font-bold">{unnumbered?"كيس بدون رقم مطبوع":box.bag} — {action==="count"?"عدّ النقدية":"تأكيد استلام الكيس"}</h2>
        <button type="button" className="text-sm underline" onClick={()=>setSelected(null)}>رجوع</button>
      </div>
      <p className="text-sm text-slate-600">الماكينة: {box.machines.map(m=>m.name).join("، ")} · السحب: <bdi>{fmt(box.collected_at)}</bdi></p>
      {action!=="count"?<>
        {!isUnnumberedCashReference(box.bag)?<label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-950">
          <input type="checkbox" checked={noPrintedNumber} onChange={e=>setNoPrintedNumber(e.target.checked)}/>
          هذا الكيس لا يحمل رقماً مطبوعاً من المصنع (مرجع السحب القديم داخل النظام ليس ختمًا مادياً)
        </label>:null}
        {unnumbered?<>
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
            لا يوجد رقم كيس للمطابقة. افتح سجل السحب وصوره وطابق الكيس بوقت وموقع السحب وصورة الإيداع. إذا لم تستطع تحديد نفس الكيس، لا تؤكد الاستلام. سيُسجَّل غياب الختم كحالة تحتاج للمراجعة.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/cash-collections/${box.id}`} className="link-secondary text-sm">
              صورة السحب عند الماكينة
            </Link>
            <Link href={`/cash-handling?id=${box.id}`} className="link-secondary text-sm">
              صورة الإيداع وسجل العهدة
            </Link>
          </div>
          <label className="block space-y-2 text-sm">
            <span>ملاحظة إضافية عن حالة الكيس (اختياري)</span>
            <textarea className="field-input" rows={2} value={note} maxLength={300} onChange={e=>setNote(e.target.value)}/>
          </label>
        </>:<label className="block space-y-2 text-sm font-semibold">
          <span>اكتب رقم الكيس المطبوع الموجود داخل الخزنة</span>
          <input className="field-input" dir="ltr" required autoComplete="off" maxLength={80} value={bagId} onChange={e=>setBagId(e.target.value.toUpperCase())}/>
        </label>}
        {!unnumbered?<>
          <label className="block space-y-2 text-sm font-semibold">
            <span>حالة الختم قبل فتح الكيس</span>
            <select className="field-input" value={seal} onChange={e=>setSeal(e.target.value as typeof seal)}>
              <option value="intact">سليم ومطابق</option>
              <option value="broken">ختم مفتوح أو مكسور</option>
              <option value="mismatch">وجود اختلاف يحتاج مراجعة</option>
            </select>
          </label>
          {seal!=="intact"||action==="takeover"?<label className="block space-y-2 text-sm">
            <span>{action==="takeover"?"ملاحظة استلام العهدة من المندوب":"اشرح المشكلة"}</span>
            <textarea className="field-input" minLength={3} rows={2} required value={note} onChange={e=>setNote(e.target.value)}/>
          </label>:null}
        </>:null}
      </>:<>
        <label className="block space-y-2 text-sm font-semibold">
          <span>مجموع النقدية التي عُدّت فعلياً — دينار ليبي</span>
          <input className="field-input" dir="ltr" type="text" required inputMode="decimal" value={amount}
            onChange={e=>setAmount(e.target.value)} placeholder="0.00"/>
        </label>
        <label className="block space-y-2 text-sm font-semibold">
          <span>مكان المبلغ بعد العد</span>
          <input className="field-input" required minLength={2} maxLength={180} value={cashLocation} onChange={e=>setCashLocation(e.target.value)}/>
        </label>
      </>}
      <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm font-semibold">
        <input type="checkbox" className="mt-1" checked={physical} onChange={e=>setPhysical(e.target.checked)} required/>
        {action==="count"?"أؤكد أنني فتحت الكيس وعددت النقدية فعلياً، ولم أنسخ أي توقعات من XY.":
          unnumbered
            ? "أؤكد أنني فتحت الخزنة، وشاهدت الكيس فعلياً، وقارنت صور السحب والإيداع واسم الماكينة ووقت السحب. أعلم أن غياب رقم الختم يحتاج مراجعة."
            : "أؤكد أنني فتحت الخزنة وشاهدت الكيس فعلياً وتحققت من الرقم والختم."}
      </label>
      {stored(requestKey(box.id,action))?<p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">هناك حفظ سابق غير مؤكد؛ ستُعاد نفس العملية بنفس المرجع، دون تكرار عهدة النقد.</p>:null}
      <button type="submit" disabled={busy||!physical} className="btn-primary min-h-12 w-full disabled:opacity-50">
        {busy?"جارٍ الحفظ...":action==="count"?"تأكيد العدّ الحقيقي":"تأكيد الاستلام الحقيقي"}
      </button>
    </form>:null}
    {!loading&&!box?<div className="space-y-3">
      <h2 className="font-bold">أكياس تنتظر التأكد من وجودها في الخزنة</h2>
      {!ready.length?<p className="rounded-xl border bg-white p-4 text-sm text-slate-600">لا يوجد كيس ينتظر استلامك حالياً.</p>:null}
      {ready.map(item=><button type="button" key={item.id} onClick={()=>select(item.id)}
        className="w-full rounded-xl border border-slate-200 bg-white p-4 text-right hover:border-emerald-400">
        <b>{isUnnumberedCashReference(item.bag)?"كيس غير مرقم":item.bag}</b><p className="text-sm text-slate-600">{item.machines.map(m=>m.name).join("، ")}</p>
        <p className="mt-2 text-sm font-semibold text-emerald-800">تأكيد وجود الكيس واستلامه ←</p>
      </button>)}
      <h2 className="pt-3 font-bold">أكياس استلمتها وتحتاج عدّاً</h2>
      {!toCount.length?<p className="rounded-xl border bg-white p-4 text-sm text-slate-600">لا يوجد مبلغ في عهدتك بانتظار العدّ.</p>:null}
      {toCount.map(item=><button type="button" key={item.id} onClick={()=>select(item.id)}
        className="w-full rounded-xl border border-sky-200 bg-white p-4 text-right hover:border-sky-400">
        <b>{isUnnumberedCashReference(item.bag)?"كيس غير مرقم":item.bag}</b><p className="text-sm text-slate-600">{item.machines.map(m=>m.name).join("، ")}</p>
        <p className="mt-2 text-sm font-semibold text-sky-800">فتح وعدّ النقدية ←</p>
      </button>)}
    </div>:null}
    <p className="text-xs leading-5 text-slate-500">
      إذا لم تجد الكيس أو لم تستطع مطابقته مع الصور ومعلومات الماكينة، فلا تؤكد الاستلام. اتركه معلقاً وسجّل المشكلة في سجل النقدية.
    </p>
    <div className="flex flex-wrap gap-3 text-sm font-semibold">
      <button type="button" className="text-emerald-800 underline" onClick={()=>setReload(n=>n+1)}>تحديث</button>
      <Link href="/cash-collections/refills" className="text-emerald-800 underline">سجل النقدية والمتأخرات</Link>
      <Link href="/cash-handling" className="text-slate-700 underline">سجل العهدة الكامل</Link>
    </div>
  </main>;
}
