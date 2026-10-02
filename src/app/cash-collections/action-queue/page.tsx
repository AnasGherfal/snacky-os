import Link from "next/link";
import {redirect} from "next/navigation";
import {DataTable,EmptyState,PageHeader,SecondaryButton,StatusBadge} from "@/components/ui";
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from "@/lib/auth";
import {hasAnyRole} from "@/lib/authz";
import {lyd} from "@/lib/format";

export const dynamic="force-dynamic";

function fmt(value:unknown){
 if(!value)return "-";
 const d=new Date(String(value));
 return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Africa/Tripoli"}).format(d);
}
function ageDays(value:unknown){
 const t=Date.parse(String(value??""));if(!Number.isFinite(t))return null;
 return Math.max(0,Math.floor((Date.now()-t)/86400000));
}
function actionFor(row:any){
 if(row.reconciliation_status==="variance_review")return {key:"variance",label:"Owner variance decision",tone:"rose"};
 if(row.custody_status==="removed")return {key:"receive",label:"Receive into storage",tone:"amber"};
 if(row.custody_status==="in_storage")return {key:"count",label:"Count stored cash",tone:"amber"};
 if(row.custody_status==="counted"&&row.reconciliation_status==="pending")return {key:"vms",label:"Compare with VMS",tone:"sky"};
 return {key:"other",label:"Review",tone:"slate"};
}
function money(value:unknown){return value===null||value===undefined?"-":lyd(Number(value));}

export default async function CashActionQueuePage(){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=="active"||!hasAnyRole(profile,["owner","admin"]))redirect("/unauthorized");
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return <EmptyState title="Cash Action Queue unavailable" body="The signed-in database session is unavailable."/>;

 const cutoff=new Date(Date.now()-30*86400000).toISOString();
 const {data,error}=await db.from("cash_collections")
  .select("id,cash_bag_id,collected_at,custody_status,reconciliation_status,review_status,actual_cash_collected,vms_expected_cash,variance,operator:team_members!cash_collections_operator_id_fkey(full_name),machine_links:cash_collection_machines(machine:machines(name,machine_code,location:locations(name)))")
  .is("voided_at",null)
  .gte("collected_at",cutoff)
  .or("custody_status.in.(removed,in_storage,counted),reconciliation_status.eq.variance_review")
  .order("collected_at",{ascending:true})
  .limit(300);

 if(error){
  console.error("[cash-action-queue] load failed",error);
  return <EmptyState title="Cash Action Queue unavailable" body="Snacky OS could not load current cash controls."/>;
 }

 const rows=(data??[]).map((row:any)=>({...row,action:actionFor(row),age_days:ageDays(row.collected_at)}));
 const actionable=rows.filter((row:any)=>["receive","count","vms","variance"].includes(row.action.key));
 const buckets={
  receive:actionable.filter((r:any)=>r.action.key==="receive"),
  count:actionable.filter((r:any)=>r.action.key==="count"),
  vms:actionable.filter((r:any)=>r.action.key==="vms"),
  variance:actionable.filter((r:any)=>r.action.key==="variance"),
  overdue:actionable.filter((r:any)=>Number(r.age_days??0)>=3),
 };
 const visibleCards=[
  ["Owner variance decisions",buckets.variance.length,"#variance"],
  ["Waiting for physical count",buckets.count.length,"#count"],
  ["Waiting for storage receipt",buckets.receive.length,"#receive"],
  ["Waiting for VMS comparison",buckets.vms.length,"#vms"],
  ["Open 3+ days",buckets.overdue.length,"#all-current"],
 ].filter(([,count])=>Number(count)>0) as Array<[string,number,string]>;

 return <div className="space-y-6">
  <PageHeader title="Cash Action Queue" subtitle="Current cash only. Legacy backlog stays in Data Health and does not pollute today’s operating queue." action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/cash-collections">Cash Custody</SecondaryButton><SecondaryButton href="/operations-health">Data Health</SecondaryButton></div>}/>

  {visibleCards.length?<section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{visibleCards.map(([label,count,href])=><Link key={label} href={href} className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-xs font-medium text-slate-600">{label}</div><strong className="mt-1 block text-3xl">{count}</strong></Link>)}</section>:<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">No current cash actions need attention.</div>}

  <section className="surface-card" id="all-current">
   <div className="mb-4"><h2 className="text-lg font-semibold">Current actions</h2><p className="mt-1 text-sm text-slate-500">Sorted by oldest first. Open the cash bag to complete the existing custody/count/VMS workflow.</p></div>
   {!actionable.length?<EmptyState title="Current cash is clear" body="No unresolved cash from the last 30 days requires action."/>:
   <DataTable headers={["Age","Bag","Collector","Stage","Counted","Expected","Variance","Next action"]}>{actionable.map((row:any)=>{
    const machines=(row.machine_links??[]).map((x:any)=>x.machine?.location?.name??x.machine?.name??x.machine?.machine_code).filter(Boolean);
    return <tr key={row.id} id={row.action.key}>
      <td className={Number(row.age_days??0)>=3?"font-semibold text-rose-700":""}>{row.age_days===null?"-":row.age_days+"d"}</td>
      <td><div className="font-semibold">{row.cash_bag_id??row.id.slice(0,8)}</div><div className="max-w-xs text-xs text-slate-500">{machines.length?machines.join(" · "):"Cash batch"} · {fmt(row.collected_at)}</div></td>
      <td>{row.operator?.full_name??"-"}</td>
      <td><div className="flex flex-wrap gap-1"><StatusBadge status={row.custody_status}/><StatusBadge status={row.reconciliation_status}/></div></td>
      <td>{money(row.actual_cash_collected)}</td>
      <td>{money(row.vms_expected_cash)}</td>
      <td className={Number(row.variance??0)!==0?"font-semibold text-rose-700":""}>{row.variance===null||row.variance===undefined?"-":money(row.variance)}</td>
      <td><div className="space-y-2"><div className="text-sm font-semibold">{row.action.label}</div><Link href={"/cash-collections/"+row.id} className="btn-primary inline-flex px-3 py-2">Open & complete</Link></div></td>
    </tr>})}</DataTable>}
  </section>

  {buckets.variance.length?<section className="rounded-xl border border-rose-200 bg-rose-50 p-4" id="variance"><strong className="text-rose-900">Variance decisions come first</strong><p className="mt-1 text-sm text-rose-800">These already have a VMS comparison and need an owner decision. Do not classify them as legacy while they are current.</p></section>:null}
 </div>;
}
