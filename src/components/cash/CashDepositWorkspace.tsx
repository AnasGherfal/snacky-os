"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { prepareCashPhoto } from "@/lib/cash-photo";
import type { CashWorkspace,CashBox } from "@/lib/cash-handover";

type PendingDeposit={
  requestId:string;collectionId:string;revision:number;bagId:string;
  safe:string;receiverId:string;notes:string;
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
    setSelected(id);setNumber("");setPhoto(null);setConfirmed(false);setNotes("");
    setReceiver(next.assigned_to??(view?.counters.some(p=>p.id===suggestedReceiverId)?suggestedReceiverId??"":""));
    setError("");setSuccess("");
    window.history.replaceState(null,"",`/cash-handling/deposit?id=${encodeURIComponent(id)}`);
    const pending=storedPending(id);
    if(pending)setNumber(pending.bagId);
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!box||busy)return;
    setBusy(true);setError("");setSuccess("");
    try{
      const cleanNumber=number.trim().toUpperCase();
      if(cleanNumber!==box.bag?.trim().toUpperCase())throw Error("رقم الكيس لا يطابق الكيس المسجل عند الماكينة.");
      if(!confirmed)throw Error("لا تسجّل الإيداع قبل وضع الكيس فعلياً في الخزنة.");
      if(!photo)throw Error("صوّر الكيس المختوم بجانب فتحة الخزنة قبل إسقاطه.");
      let pending=storedPending(box.id);
      if(!pending){
        if(!selectedRecipient)throw Error("اختر المستلم المخوّل.");
        pending={
          requestId:crypto.randomUUID(),collectionId:box.id,revision:box.revision,
          bagId:cleanNumber,safe:safeLabel,receiverId:selectedRecipient,
          notes:notes.trim(),
        };
        try{sessionStorage.setItem(pendingKey(box.id),JSON.stringify(pending));}
        catch{throw Error("تعذر حفظ مرجع الطلب على هذا الهاتف. فعّل التخزين وأعد المحاولة.");}
      }
      const compact=await prepareCashPhoto(photo);
      const form=new FormData();
      form.set("request_id",pending.requestId);
      form.set("collection_id",pending.collectionId);
      form.set("revision",String(pending.revision));
      form.set("bag_id",pending.bagId);
      form.set("assigned_to",pending.receiverId);
      form.set("storage_location",pending.safe);
      form.set("notes",pending.notes);
      form.set("photo",compact);
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
      setSuccess(`تم تسجيل وضع الكيس ${pending.bagId} في ${pending.safe}. بانتظار التأكد من الاستلام الفعلي من المسؤول.`);
      setSelected(null);setNumber("");setReceiver("");setPhoto(null);setConfirmed(false);setNotes("");
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
        خطوة واحدة لكل كيس: تأكد من الرقم، صوّر الكيس والخزنة، ضعه داخل فتحة الإيداع وأغلقها ثم احفظ.
        الإيداع المسجّل هنا <b>إقرار من المشغّل</b>، وليس تأكيد الاستلام النهائي؛ الشخص المخوّل يتحقق منه عند فتح الخزنة.
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
          <h2 className="text-lg font-bold text-slate-950">إيداع الكيس {box.bag}</h2>
          <button type="button" className="text-sm font-semibold text-slate-600 underline"
            onClick={()=>{setSelected(null);setError("");}}>رجوع للقائمة</button>
        </div>
        <p className="text-sm text-slate-600">{box.machines.map(m=>m.name).join(" · ")} · تم سحبه <bdi>{formatDate(box.collected_at)}</bdi></p>
        <label className="block space-y-2 text-sm font-semibold">
          <span>أعد كتابة رقم الكيس الذي تمسكه فعلياً</span>
          <input className="field-input" dir="ltr" autoComplete="off" maxLength={80}
            value={number} onChange={e=>setNumber(e.target.value.toUpperCase())}
            required placeholder="رقم الختم على الكيس" />
        </label>
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
          <span>صورة الكيس المختوم بجانب فتحة الخزنة</span>
          <input className="field-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
            required onChange={e=>setPhoto(e.target.files?.[0]??null)} />
          <span className="block text-xs font-normal text-slate-500">أظهر رقم الكيس والختم ولوحة الخزنة. لا تفتح الكيس ولا تصوّر الأوراق النقدية.</span>
        </label>
        <label className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-950">
          <input className="mt-1" type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
          أؤكد أنني وضعت هذا الكيس داخل فتحة الخزنة وأغلقتها فعلياً. أعلم أن المستلم سيطابق الرقم عند فتح الخزنة.
        </label>
        {storedPending(box.id)?<p className="rounded-lg bg-amber-50 p-3 text-xs font-semibold text-amber-900">هذه محاولة حفظ سابقة غير مؤكدة. ستُعاد بنفس المرجع، ولا تُسقط الكيس مرة ثانية.</p>:null}
        <button type="submit" disabled={busy||!confirmed||!number.trim()||!photo}
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
        <span className="block text-base font-bold text-slate-950">{item.bag}</span>
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
          href={`/cash-handling?id=${item.id}`}>{item.bag}</Link>)}
      </div>
    </section>:null}
    <div className="flex flex-wrap gap-3 text-sm font-semibold">
      <button type="button" onClick={()=>setRefreshKey(x=>x+1)} className="text-emerald-800 underline">تحديث القائمة</button>
      <Link href="/cash-handling" className="text-slate-700 underline">عرض سجل العهدة الكامل</Link>
    </div>
  </main>;
}
