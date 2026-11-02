"use client";

import { useState } from "react";

type CleanupResult = {
 ok:boolean; error?:string; candidates?:number; processed?:number; eligible?:number;
 deleted?:number; reclaimedBytes?:number; nextCursor?:string|null; done?:boolean;
 results?:Array<{kind:string;status:string;bytes?:number}>;
};
type Progress={inspected:number;eligible:number;eligibleBytes:number;deleted:number;reclaimedBytes:number;errors:number;statuses:Record<string,number>};

export function OwnerPhotoCleanup(){
 const [busy,setBusy]=useState<"inspect"|"delete"|null>(null);
 const [acknowledge,setAcknowledge]=useState(false);
 const [progress,setProgress]=useState<Progress>({inspected:0,eligible:0,eligibleBytes:0,deleted:0,reclaimedBytes:0,errors:0,statuses:{}});
 const [notice,setNotice]=useState("");
 const size=(bytes:number)=>(bytes/1_000_000).toFixed(1)+" MB";

 async function run(action:"inspect"|"delete"){
  if(busy || (action==="delete" && !acknowledge)) return;
  setBusy(action);
  setNotice("");
  let cursor:string|null=null;
  let next:Progress={inspected:0,eligible:0,eligibleBytes:0,deleted:0,reclaimedBytes:0,errors:0,statuses:{}};
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
    if(!resp.ok || !data.ok){
      if(data.error==="cross_origin_request_blocked")throw Error("The site origin check blocked this request. Open Photo Cleanup from your normal Snacky OS Settings page.");
      if(data.error==="owner_only")throw Error("This operation requires an active Snacky owner account. No photos were deleted.");
      throw Error(data.error||"The cleanup request was rejected. No success has been confirmed.");
    }
    const statuses={...next.statuses};
    for(const item of data.results??[])statuses[item.status]=(statuses[item.status]??0)+1;
    next={inspected:next.inspected+(data.processed??0),
      eligible:next.eligible+(data.eligible??0),
      eligibleBytes:next.eligibleBytes+(data.results??[]).filter(r=>r.status==="eligible"||r.status==="deleted").reduce((a,r)=>a+(r.bytes??0),0),
      deleted:next.deleted+(data.deleted??0),
      reclaimedBytes:next.reclaimedBytes+(data.reclaimedBytes??0),
      errors:next.errors+(data.results??[]).filter(r=>r.status==="failed_closed_no_confirmation").length,
      statuses};
    setProgress(next);
    if(data.done){
      setNotice(action==="inspect"
        ? `Preview finished: ${next.eligible} old photos eligible (about ${size(next.eligibleBytes)}). NOTHING WAS DELETED.`
        : next.deleted>0
          ? `Verified removal of ${next.deleted} photos (${size(next.reclaimedBytes)}). Any skipped or failed items are shown below.`
          : "NO PHOTOS DELETED. Check the reasons below; a completed scan alone never frees storage.");
      return;
    }
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
   {busy&&<p role="status" className="rounded-lg bg-slate-100 p-3 text-sm">Checking photos… {progress.inspected} reviewed, {progress.deleted} deleted, {size(progress.reclaimedBytes)} verified removed.</p>}
   {notice&&<p role="status" className="rounded-lg bg-slate-100 p-3 text-sm">{notice}</p>}
   {Object.keys(progress.statuses).length>0&&(
     <div className="rounded-xl border border-slate-200 p-3">
       <h3 className="text-sm font-semibold">Actual results — reasons for skipped photos</h3>
       <ul className="mt-2 space-y-1 text-sm">
         {Object.entries(progress.statuses).sort((a,b)=>b[1]-a[1]).map(([status,count])=>(
           <li key={status} className="flex justify-between gap-2">
             <span>{({
               eligible:"Eligible (preview only)",deleted:"Removed and verified",
               photo_not_old_enough:"Too new or missing modification date",
               already_missing:"Already absent from Storage",
               quantity_evidence_protected:"Protected quantity screenshot",
               not_compressor_proof:"Not a confirmed compressor photo",
               not_exclusive_machine_photo:"Not an exclusive machine overview",
               invalid_file_metadata:"Invalid Storage size",
               unverifiable_source_version:"Missing file version / ETag",
               source_changed_or_protected:"Photo changed during verification",
               failed_closed_no_confirmation:"Deletion could not be confirmed",
             } as Record<string,string>)[status]??status}</span>
             <strong>{count}</strong>
           </li>
         ))}
       </ul>
     </div>
   )}
   <p className="text-sm font-semibold text-red-700">The optional preview never reduces Supabase usage. Only the red delete action does.</p>
   <p className="text-xs text-slate-500">Keep this page open while processing. A refresh is safe: previously removed files are skipped when scanned again.</p>
  </section>
 );
}
