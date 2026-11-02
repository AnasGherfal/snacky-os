"use client";

import { useState } from "react";

type CleanupResult = {
 ok:boolean; error?:string; candidates?:number; processed?:number; eligible?:number;
 deleted?:number; reclaimedBytes?:number; nextCursor?:string|null; done?:boolean;
 results?:Array<{kind:string;status:string;bytes?:number}>;
};
type Progress={inspected:number;eligible:number;eligibleBytes:number;deleted:number;reclaimedBytes:number;errors:number};

export function OwnerPhotoCleanup(){
 const [busy,setBusy]=useState<"inspect"|"delete"|null>(null);
 const [acknowledge,setAcknowledge]=useState(false);
 const [progress,setProgress]=useState<Progress>({inspected:0,eligible:0,eligibleBytes:0,deleted:0,reclaimedBytes:0,errors:0});
 const [notice,setNotice]=useState("");
 const size=(bytes:number)=>(bytes/1_000_000).toFixed(1)+" MB";

 async function run(action:"inspect"|"delete"){
  if(busy || (action==="delete" && !acknowledge)) return;
  setBusy(action);
  setNotice("");
  let cursor:string|null=null;
  let next:Progress={inspected:0,eligible:0,eligibleBytes:0,deleted:0,reclaimedBytes:0,errors:0};
  try{
   for(let batch=0;batch<2000;batch++){
    const resp=await fetch("/api/ops/purge-aged-refill-photos",{
     method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({action,cursor,acknowledgement:action==="delete"?"DELETE OLD PHOTOS":undefined}),
     cache:"no-store",
    });
    const type=resp.headers.get("content-type") ?? "";
    if(!type.includes("application/json"))throw Error("This is not the authenticated cleanup API. Open it from the normal Snacky OS Settings page and sign in.");
    const data=await resp.json() as CleanupResult;
    if(!resp.ok || !data.ok)throw Error(resp.status===403?"Owner access denied. Sign in with the active Snacky owner account.":(data.error||"The cleanup request was rejected"));
    next={inspected:next.inspected+(data.processed??0),
      eligible:next.eligible+(data.eligible??0),
      eligibleBytes:next.eligibleBytes+(data.results??[]).filter(r=>r.status==="eligible").reduce((a,r)=>a+(r.bytes??0),0),
      deleted:next.deleted+(data.deleted??0),
      reclaimedBytes:next.reclaimedBytes+(data.reclaimedBytes??0),
      errors:next.errors+(data.results??[]).filter(r=>r.status==="failed_closed_no_confirmation").length};
    setProgress(next);
    if(data.done){setNotice(
       action==="inspect"?"Preview complete — NOTHING WAS DELETED. Tick the confirmation and press the RED delete button to actually free space.":
       "Cleanup finished. The total shown reflects Storage API deletions verified as absent."
     );return;}
    if(!data.nextCursor||data.nextCursor===cursor)throw Error("The next batch could not be determined safely");
    cursor=data.nextCursor;
   }
   throw Error("Too many batches. No further deletion was attempted.");
  }catch(e){setNotice(e instanceof Error?e.message:"Cleanup was interrupted. You can rescan safely.");}
  finally{setBusy(null);}
 }
 return (
  <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-sm">
   <p className="text-sm leading-7" dir="rtl">
    هذا الإجراء يحذف نهائياً صور الماكينات وصور إثبات تشغيل الكمبريسور
    اللي مرّ عليها أكثر من 30 يوم. صور الكميات والكاش والفواتير مشمولة بالحماية ومش حتنحذف.
   </p>
   <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6">
    <strong>Permanent deletion:</strong> Old photographs will no longer open from route history.
    The historical route, issue and refill records are retained.
    No external archive or recovery copy is created by this action.
   </div>
   <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{progress.inspected}</div>References checked</div>
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{progress.eligible}</div>Eligible pictures</div>
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{size(progress.eligibleBytes)}</div>Potential savings (scan)</div>
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{progress.deleted}</div>Confirmed deleted</div>
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{size(progress.reclaimedBytes)}</div>Verified bytes removed</div>
    <div className="rounded-lg bg-slate-100 p-3"><div className="font-semibold">{progress.errors}</div>Unconfirmed errors</div>
   </div>
   <button disabled={!!busy} onClick={()=>run("inspect")} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 font-medium text-slate-900 disabled:opacity-50">
    {busy==="inspect"?"Scanning — no deletion…":"Optional preview: scan eligible photos (does NOT delete)"}
   </button>
    <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm">
      <input type="checkbox" checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)} className="mt-1" />
      I authorize permanent deletion of eligible old machine and compressor photos. I understand these originals cannot be recovered.
    </label>
   <button disabled={!!busy||!acknowledge} onClick={()=>run("delete")} className="w-full rounded-xl bg-red-700 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
    {busy==="delete"?"Deleting and verifying…":"PERMANENTLY DELETE machine/compressor photos older than 30 days"}
   </button>
   {notice&&<p role="status" className="rounded-lg bg-slate-100 p-3 text-sm">{notice}</p>}
   <p className="text-sm font-semibold text-red-700">The optional preview never reduces Supabase usage. Only the red delete action does.</p>
   <p className="text-xs text-slate-500">Keep this page open while processing. A refresh is safe: previously removed files are skipped when scanned again.</p>
  </section>
 );
}
