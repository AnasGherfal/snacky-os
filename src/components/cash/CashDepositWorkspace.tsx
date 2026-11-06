"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { prepareCashPhoto } from "@/lib/cash-photo";
import { isUnnumberedCashReference, type CashWorkspace,type CashBox } from "@/lib/cash-handover";

type PendingDeposit={
  requestId:string;collectionId:string;revision:number;bagId:string;
  safe:string;receiverId:string;notes:string;referenceMode?:"unnumbered"|"printed";
};
const pendingKey=(id:string)=>`snacky.cash.deposit.pending.v1.${id}`;
function storedPending(id:string):PendingDeposit|null {
  try {
    const raw=sessionStorage.getItem(pendingKey(id));
    const value=raw?JSON.parse(raw) as PendingDeposit:null;
    return value && value.collectionId===id ? value:null;
  } catch {return null;}
}
const formatDate=(value:string)=>new Intl.DateTimeFormat("en-GB",{
  timeZone:"Africa/Tripoli",dateStyle:"short",timeStyle:"short",
}).format(new Date(value));

export function CashDepositWorkspace({safeLabel,suggestedReceiverId}:{
  safeLabel:string;suggestedReceiverId:string|null;
}) {
  const [view,setView]=useState<CashWorkspace|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [selected,setSelected]=useState<string|null>(null);
  const [number,setNumber]=useState("");
  const [referenceMode,setReferenceMode]=useState<"unnumbered"|"printed">("unnumbered");
  const [receiver,setReceiver]=useState("");
  const [photo,setPhoto]=useState<File|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [notes,setNotes]=useState("");
  const [busy,setBusy]=useState(false);
  const [success,setSuccess]=useState("");
  const [refreshKey,setRefreshKey]=useState(0);

  useEffect(()=>{
    const fromLink=new URLSearchParams(window.location.search).get("id");
    if(fromLink)setSelected(fromLink);
  },[]);

  useEffect(()=>{
    let cancelled=false;
    async function load(){
      setLoading(true);setError("");
      try {
        const all:CashBox[]=[];
        let overview:CashWorkspace|null=null;
        for(let offset=0;offset<100;offset+=25){
          const res=await fetch(`/api/cash-handling?status=open&offset=${offset}`,{cache:"no-store"});
          const response=await res.json();
          if(!res.ok||response.ok!==true||!response.data)throw Error("تعذر تحميل الأكياس. حدّث الصفحة وحاول مرة أخرى.");
          const page=response.data as CashWorkspace;
          if(!overview)overview=page;
          all.push(...page.rows);
          if(all.length>=page.total||page.rows.length===0)break;
        }
        if(cancelled)return;
        if(!overview)throw Error("تعذر تحميل العهدة");
        setView({...overview,rows:all});
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:"تعذر تحميل الأكياس.");}
      finally{if(!cancelled)setLoading(false);}
    }
    void load();return()=>{cancelled=true;};
  },[refreshKey]);

  const bags=useMemo(()=>view?.rows.filter(b=>b.actions.includes("dropoff"))??[],[view]);
  const deposited=useMemo(()=>view?.rows.filter(b=>b.state==="dropped"||b.state==="stored")??[],[view]);
  const box=bags.find(b=>b.id===selected)??null;
  const selectedRecipient=(box?.assigned_to ?? receiver) ||
    (view?.counters.some(p=>p.id===suggestedReceiverId) ? (suggestedReceiverId ?? "") : "");
  function select(id:string){
    const next=bags.find(row=>row.id===id);
    if(!next)return;
    setSelected(id);setNumber("");setReferenceMode("unnumbered");setPhoto(null);setConfirmed(false);setNotes("");
    setReceiver(next.assigned_to??(view?.counters.some(p=>p.id===suggestedReceiverId)?suggestedReceiverId??"":""));
    setError("");setSuccess("");
    window.history.replaceState(null,"",`/cash-handling/deposit?id=${encodeURIComponent(id)}`);
    const pending=storedPending(id);
    if(pending){
      setReferenceMode(pending.referenceMode??"printed");
      if((pending.referenceMode??"printed")==="printed")setNumber(pending.bagId);
    }
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!box||busy)return;
    setBusy(true);setError("");setSuccess("");
    try{
      const cleanNumber=number.trim().toUpperCase();
      if(referenceMode==="printed"&&cleanNumber!==box.bag?.trim().toUpperCase())
        throw Error("الرقم المطبوع لا يطابق الرقم المسجل عند الماكينة.");
      if(!box.bag?.trim())throw Error("مرجع سحب النقدية غير موجود. أبلغ المسؤول.");
      if(!confirmed)throw Error("لا تسجّل الإيداع قبل وضع الكيس فعلياً في الخزنة.");
      if(!photo&&!storedPending(box.id))throw Error("صوّر الكيس المختوم بجانب فتحة الخزنة قبل إسقاطه.");
      let pending=storedPending(box.id);
      if(!pending){
        if(!selectedRecipient)throw Error("اختر المستلم المخوّل.");
        pending={
          requestId:crypto.randomUUID(),collectionId:box.id,revision:box.revision,
          bagId:box.bag.trim().toUpperCase(),safe:safeLabel,receiverId:selectedRecipient,
          notes:notes.trim(),referenceMode,
        };
        try{sessionStorage.setItem(pendingKey(box.id),JSON.stringify(pending));}
        catch{throw Error("تعذر حفظ مرجع الطلب على هذا الهاتف. فعّل التخزين وأعد المحاولة.");}
      }
      const compact=photo?await prepareCashPhoto(photo):null;
      const form=new FormData();
      form.set("request_id",pending.requestId);
      form.set("collection_id",pending.collectionId);
      form.set("revision",String(pending.revision));
      form.set("bag_id",pending.bagId);
      form.set("reference_mode",pending.referenceMode??"printed");
      form.set("assigned_to",pending.receiverId);
      form.set("storage_location",pending.safe);
      form.set("notes",pending.notes);
      if(compact)form.set("photo",compact);
      const response=await fetch("/api/cash-handling/deposit",{
        method:"POST",body:form,cache:"no-store",signal:AbortSignal.timeout(40000),
      });
      const result=await response.json();
      if(!response.ok||result.ok!==true){
        if(result.retryable){
          throw Error("لم يتأكد حفظ الإيداع. جرّب بنفس الكيس ولا تسجّل إيداعاً جديداً. "+(result.message??""));
        }
        throw Error(result.message??"تعذر حفظ الإيداع. راجع العهدة قبل المحاولة.");
      }
      try{sessionStorage.removeItem(pendingKey(box.id));}catch{/* already saved */}
      setSuccess((pending.referenceMode??"printed")==="unnumbered"
        ? `تم تسجيل إيداع الكيس غير المرقم في ${pending.safe}. الاستلام والعد الفعليان بانتظار المسؤول.`
        : `تم تسجيل وضع الكيس ${pending.bagId} في ${pending.safe}. بانتظار التأكد من الاستلام الفعلي من المسؤول.`);
      setSelected(null);setNumber("");setReferenceMode("unnumbered");setReceiver("");setPhoto(null);setConfirmed(false);setNotes("");
      window.history.replaceState(null,"","/cash-handling/deposit");
      setRefreshKey(value=>value+1);
    }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الإيداع.");}
    finally{setBusy(false);}
  }

  return <main dir="rtl" className="mx-auto max-w-3xl space-y-5 p-4">
    <header className="space-y-2">
      <Link href="/cash-handling" className="text-sm font-semibold text-emerald-800">النقدية</Link>
      <h1 className="text-2xl font-bold text-slate-950">إيداع أكياس النقدية في الخزنة</h1>
      <p className="text-sm leading-6 text-slate-600">
        اختَر سجل النقدية حسب الماكينة ووقت السحب، صوّر الكيس المغلق بجانب الخزنة، ثم أودعه واحفظ الإقرار.
        حالياً يمكن إيداع الأكياس غير المرقمة دون كتابة رقم عليها. الإيداع <b>إقرار من المشغّل فقط</b> وليس تأكيد الاستلام أو العد؛ المسؤول يتحقق من الكيس والصور عند فتح الخزنة.
      </p>
    </header>
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="text-sm font-semibold text-amber-900">معك وتحتاج إيداع</div>
        <div className="mt-1 text-2xl font-bold text-amber-950">{bags.length}</div>
      </div>
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="text-sm font-semibold text-emerald-900">تم الإبلاغ عن إيداعها</div>
        <div className="mt-1 text-2xl font-bold text-emerald-950">{deposited.length}</div>
      </div>
    </div>
    {loading?<p className="rounded-xl border bg-white p-4">جارٍ تحميل الأكياس...</p>:null}
    {success?<div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">{success}</div>:null}
    {error?<div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-900">{error}</div>:null}

    {box ? (
      <form onSubmit={save} className="space-y-4 rounded-2xl border-2 border-emerald-400 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-slate-950">{referenceMode==="unnumbered"?"إيداع كيس نقدية غير مرقم":`إيداع الكيس ${box.bag}`}</h2>
          <button type="button" className="text-sm font-semibold text-slate-600 underline"
            onClick={()=>{setSelected(null);setError("");}}>رجوع للقائمة</button>
        </div>
        <p className="text-sm text-slate-600">{box.machines.map(m=>m.name).join(" · ")} · تم سحبه <bdi>{formatDate(box.collected_at)}</bdi></p>
        <fieldset className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <legend className="font-semibold text-emerald-950">هل الكيس يحمل رقماً مطبوعاً؟</legend>
          <label className="flex min-h-10 items-center gap-2">
            <input type="radio" name="reference_mode" checked={referenceMode==="unnumbered"}
              disabled={Boolean(storedPending(box.id))} onChange={()=>setReferenceMode("unnumbered")}/>
            لا، الكيس بدون رقم مطبوع (المعتاد حالياً)
          </label>
          <label className="flex min-h-10 items-center gap-2">
            <input type="radio" name="reference_mode" checked={referenceMode==="printed"}
              disabled={Boolean(storedPending(box.id))} onChange={()=>setReferenceMode("printed")}/>
            نعم، يوجد رقم ختم مطبوع
          </label>
          {referenceMode==="unnumbered"?<p className="rounded-lg bg-amber-50 p-2 text-xs leading-5 text-amber-950">
            لا تكتب رقماً على الكيس. هذا السحب معروف في النظام بواسطة الماكينة والتاريخ والصورة. عدم وجود رقم مطبوع سيظل ظاهراً للمسؤول عند المراجعة.
          </p>:null}
          {isUnnumberedCashReference(box.bag)?<p className="text-xs text-slate-600">
            مرجع داخلي آلي (ليس رقماً على الكيس): <bdi className="font-mono">{box.bag}</bdi>
          </p>:null}
        </fieldset>
        {referenceMode==="printed"?<label className="block space-y-2 text-sm font-semibold">
          <span>أعد كتابة رقم الختم المطبوع فعلاً على الكيس</span>
          <input className="field-input" dir="ltr" autoComplete="off" maxLength={80}
            value={number} onChange={e=>setNumber(e.target.value.toUpperCase())}
            required placeholder="رقم الختم على الكيس" />
        </label>:null}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
          <span className="font-semibold">مكان الإيداع: </span><bdi>{safeLabel}</bdi>
        </div>
        <label className="block space-y-2 text-sm font-semibold">
          <span>الشخص المخوّل بفتح الخزنة واستلام الأكياس لاحقاً</span>
          {box.assigned_to ? <div className="rounded-lg bg-slate-100 p-3">{box.assignee??"المسؤول المحدد"}</div>:
            <select className="field-input" required value={selectedRecipient} onChange={e=>setReceiver(e.target.value)}>
              <option value="">اختر المسؤول</option>
              {(view?.counters??[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>}
        </label>
        <label className="block space-y-2 text-sm font-semibold">
          <span>{referenceMode==="unnumbered"?"صورة الكيس المغلق بجانب فتحة الخزنة":"صورة الكيس المختوم بجانب فتحة الخزنة"}</span>
          <input className="field-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
            required={!storedPending(box.id)} onChange={e=>setPhoto(e.target.files?.[0]??null)} />
          <span className="block text-xs font-normal text-slate-500">
            {referenceMode==="unnumbered"
              ? "أظهر نفس الكيس ومكان الإيداع بوضوح؛ لا تفتحه ولا تصوّر الأوراق النقدية. سيطابقه المسؤول مع صورة السحب."
              : "أظهر رقم الختم ولوحة الخزنة. لا تفتح الكيس ولا تصوّر الأوراق النقدية."}
          </span>
          {storedPending(box.id)?<span className="block text-xs font-semibold text-amber-900">إذا ضاع رد الحفظ بعد رفع الصورة، تستطيع تأكيد المحاولة السابقة بدون إخراج الكيس من الخزنة. النظام يتحقق من صورة الطلب الأصلية.</span>:null}
        </label>
        <label className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-950">
          <input className="mt-1" type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
          أؤكد أنني وضعت هذا الكيس فعلياً داخل فتحة الخزنة وأغلقتها. أعلم أن المسؤول يجب أن يتحقق من الكيس والصورتين عند الاستلام، ولن يُعتبر مختوماً بختم مرقّم إذا لم يحمل رقماً مطبوعاً.
        </label>
        {storedPending(box.id)?<p className="rounded-lg bg-amber-50 p-3 text-xs font-semibold text-amber-900">هذه محاولة حفظ سابقة غير مؤكدة. ستُعاد بنفس المرجع، ولا تُسقط الكيس مرة ثانية.</p>:null}
        <button type="submit" disabled={busy||!confirmed||(referenceMode==="printed"&&!number.trim())||(!photo&&!storedPending(box.id))}
          className="btn-primary min-h-12 w-full disabled:opacity-50">
          {busy?"جارٍ التأكيد...":"حفظ إقرار الإيداع"}
        </button>
      </form>
    ) : null}

    {!loading && !box ? <section className="space-y-3">
      <h2 className="font-bold text-slate-900">الأكياس التي لم تسجل إيداعها</h2>
      {bags.length===0?<p className="rounded-xl border bg-white p-5 text-sm text-slate-600">لا توجد أكياس تنتظر منك الإيداع.</p>:null}
      {bags.map(item=><button key={item.id} type="button" onClick={()=>select(item.id)}
        className="w-full rounded-xl border border-slate-200 bg-white p-4 text-right transition hover:border-emerald-500">
        <span className="block text-base font-bold text-slate-950">{isUnnumberedCashReference(item.bag)?"كيس بدون رقم مطبوع":item.bag}</span>
        <span className="mt-1 block text-sm text-slate-600">{item.machines.map(m=>m.name).join("، ")}</span>
        <span className="mt-1 block text-xs text-slate-500">سحب: <bdi>{formatDate(item.collected_at)}</bdi></span>
        <span className="mt-2 block text-sm font-bold text-emerald-800">تسجيل الإيداع ←</span>
      </button>)}
    </section>:null}
    {deposited.length>0?<section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <h2 className="font-bold text-emerald-950">تم الإبلاغ عن إيداعها — تأكيد المستلم منفصل</h2>
      <p className="mt-1 text-xs text-emerald-900">لا تُعتبر مستلمة أو معدودة حتى يفحص المسؤول الأكياس بنفسه.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {deposited.slice(0,15).map(item=><Link key={item.id} className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-950"
          href={`/cash-handling?id=${item.id}`}>{isUnnumberedCashReference(item.bag)?"كيس غير مرقم":item.bag}</Link>)}
      </div>
    </section>:null}
    <div className="flex flex-wrap gap-3 text-sm font-semibold">
      <button type="button" onClick={()=>setRefreshKey(x=>x+1)} className="text-emerald-800 underline">تحديث القائمة</button>
      <Link href="/cash-handling" className="text-slate-700 underline">عرض سجل العهدة الكامل</Link>
    </div>
  </main>;
}
