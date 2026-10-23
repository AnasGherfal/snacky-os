/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

type Machine = {id:string;name:string|null;machine_code:string|null;vms_machine_id:string|null;vms_cash_balance_lyd:number|string|null};
type Pickup = {machine_id:string|null;collected_at:string;removal_type:string|null};
const currency=(n:number)=>new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+" LYD";
function localDate(utc:string){return new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Tripoli",day:"2-digit",month:"short",year:"numeric"}).format(new Date(utc));}
function elapsedDays(utc:string){return Math.max(0,Math.floor((Date.now()-new Date(utc).getTime())/86400000));}
async function paged<T>(build:(from:number,to:number)=>any,max=10000):Promise<T[]>{
 const all:T[]=[];
 for(let from=0;from<max;from+=500){const r=await build(from,from+499);if(r.error)throw new Error(r.error.message??"Cash source read failed");
 all.push(...(r.data??[]) as T[]);if((r.data??[]).length<500)return all;}
 throw new Error("Too many cash records. No partial estimate was generated.");
}

/** Cash collection decision support, not a statement of verified physical cash balance.
 * The existing XY VMS report is authoritative for machine sales; an outdated snapshot
 * must NEVER be silently extrapolated to today's cash.
 */
export async function CashPickupPlanner(){
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return <p role="alert">Cash pickup planning unavailable — session required.</p>;
 try{
  const [machineResult, pickups, syncs] = await Promise.all([
   db.from("machines").select("id,name,machine_code,vms_machine_id,vms_cash_balance_lyd").order("name"),
   paged<Pickup>( (from,to)=>db.from("cash_collection_machines")
    .select("machine_id,removal_type,collection:cash_collections!cash_collection_machines_cash_collection_id_fkey(collected_at,voided_at)")
    .order("created_at",{ascending:false}).range(from,to) ).then(rows=>rows.map((x:any)=>({
     machine_id:x.machine_id,removal_type:x.removal_type,
     collected_at:(Array.isArray(x.collection)?x.collection[0]:x.collection)?.voided_at?"":
      String((Array.isArray(x.collection)?x.collection[0]:x.collection)?.collected_at??"")
    })).filter(x=>Boolean(x.collected_at))),
   db.from("vms_sync_runs").select("status,started_at,completed_at").eq("sync_type","sales_live")
    .in("status",["completed","completed_with_warnings"]).order("completed_at",{ascending:false}).limit(1)
  ]);
  if(machineResult.error||syncs.error)throw new Error(machineResult.error?.message??syncs.error?.message??"Unable to verify XY sales state");
  const machines=(machineResult.data??[]) as Machine[];
  const lastComplete=new Map<string,string>();
  for(const pickup of pickups){
   if(pickup.removal_type!=="full"||!pickup.machine_id)continue;
   const existing=lastComplete.get(pickup.machine_id);
   if(!existing||pickup.collected_at>existing)lastComplete.set(pickup.machine_id,pickup.collected_at);
  }
  const lastSync=syncs.data?.[0]?.completed_at??null;
  const currentSync=Boolean(lastSync&&Date.now()-new Date(lastSync).getTime()<=4*60*60*1000);
  // No balance can be calculated from the last counted bag: the bag was removed.
  // XY synchronized SALES after the removal are required. Even when sales sync is
  // fresh, cash payouts/change/refunds require a separate verification source.
  const rows=machines.filter(m=>!String(m.name??"").startsWith("[TEST]"))
   .map(m=>({...m,lastRemoval:lastComplete.get(m.id)??null,
     days:lastComplete.has(m.id)?elapsedDays(lastComplete.get(m.id)!):null,
     cashBalance:m.vms_cash_balance_lyd==null?null:Number(m.vms_cash_balance_lyd)}))
   .sort((a,b)=>(b.days??-1)-(a.days??-1)||String(a.name).localeCompare(String(b.name)));
  const largest=rows.filter(r=>r.days!=null&&r.days>=7).length;
  return <section className="surface-card space-y-4" aria-labelledby="cash-pickup-planner">
   <div className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 id="cash-pickup-planner" className="text-lg font-semibold">Cash collection priority / أولوية جمع الكاش</h2>
     <p className="mt-1 text-sm text-slate-600">Uses the existing cash-removal log. The XY cash-collection report should supply the post-removal sales total; a stale report must not be shown as cash physically in the machine.</p></div>
    <Link className="btn-secondary" href="/cash-collections">Cash removal records</Link>
   </div>
   <div className={currentSync?"rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm":"rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"} role="status">
    <strong>{currentSync?"XY live-sales synchronization exists":"Current XY cash-sales source is not verified"}</strong>
    <span className="ms-2">{lastSync?"Most recent successful transaction sync: "+localDate(lastSync)+".":"No successful XY live-sales transaction sync found. Stored monthly XY reports do not cover current October pickups."}</span>
    <p className="mt-1">A machine balance is shown only when the actual XY cash-collection/cashbox total is available and verified. Sale revenue alone does not account for change paid out, refunds, or manual cash moves.</p>
   </div>
   <div className="grid gap-3 sm:grid-cols-3">
    <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">Machines tracked</p><strong className="text-xl">{rows.length}</strong></div>
    <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">Last pickup ≥7 days</p><strong className="text-xl">{largest}</strong></div>
    <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">Verified current cash balances</p><strong className="text-xl">{rows.filter(r=>currentSync&&r.cashBalance!=null).length}</strong></div>
   </div>
   <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
    <thead><tr className="border-b bg-slate-50">{["Machine","Last recorded full removal","Days since removal","XY verified cash","Collection priority"].map(h=><th key={h} className="p-3 text-start">{h}</th>)}</tr></thead>
    <tbody>{rows.map(r=><tr key={r.id} className="border-b">
     <td className="p-3 font-semibold">{r.name??r.machine_code??"Machine"}<p className="text-xs font-normal text-slate-500">{r.machine_code}</p></td>
     <td className="p-3">{r.lastRemoval?localDate(r.lastRemoval):"Not recorded"}</td>
     <td className="p-3">{r.days??"—"}</td>
     <td className="p-3">{currentSync&&r.cashBalance!=null?currency(r.cashBalance):"Unavailable — check XY cashbox report"}</td>
     <td className="p-3">{r.days===null?"Confirm last removal":r.days>=10?"Check early · time-based":r.days>=7?"Check soon · time-based":"Recently collected / review XY"}</td>
    </tr>)}</tbody>
   </table></div>
   <p className="text-xs text-slate-600">Time-based ranking is NOT an XY amount-based ranking. A cashbox collection report can include notes, recycler and change float: confirm its amount represents cash physically removable. For accurate rankings, connect that report's per-machine verified balance to Snacky OS instead of subtracting last bag totals from gross sales.</p>
  </section>;
 }catch(error){console.error("[cash-pickup-planner] Failed to verify input",error);
  return <section className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm" role="alert">Cannot verify cash pickup data. No cash balances were assumed. Use the existing XY cash report and <Link className="underline" href="/cash-collections">cash removal records</Link>.</section>;}
}
