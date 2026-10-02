import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { DataHealthActionButton } from "@/components/DataHealthActionButton";
import { OperatorBagReconcileControl } from "@/components/OperatorBagReconcileControl";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";

export const dynamic = "force-dynamic";

function fmt(value: unknown) {
  if (!value) return "-";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(d);
}
function daysAgo(days:number){const d=new Date();d.setUTCDate(d.getUTCDate()-days);return d.toISOString();}

export default async function OperationsHealthPage() {
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!hasAnyRole(profile,["owner","admin"]))redirect("/unauthorized");
  const db=await getAuthenticatedSupabaseServerClient();
  if(!db)return <EmptyState title="Data Health unavailable" body="The signed-in database session is unavailable."/>;

  const [workspaceResult,machinesResult,locationsResult,currentCashResult]=await Promise.all([
    db.rpc("snacky_data_health_workspace_v1"),
    db.from("machines").select("id,machine_code,name,status,location_id,location:locations(id,name,address,distance_from_storage_km)").order("machine_code"),
    db.from("locations").select("id,name,address,status,distance_from_storage_km").eq("status","active").order("name"),
    db.from("cash_collections").select("id",{count:"exact",head:true}).is("voided_at",null).in("reconciliation_status",["pending","variance_review"]).gte("collected_at",daysAgo(30)).lt("collected_at",daysAgo(3)),
  ]);

  if(workspaceResult.error||!workspaceResult.data||typeof workspaceResult.data!=="object"){
    console.error("[data-health] Workspace unavailable",workspaceResult.error);
    return <EmptyState title="Data Health unavailable" body="Snacky OS could not load the cleanup workspace."/>;
  }

  const data=workspaceResult.data as any,counts=data.counts??{};
  const inventoryHealth=Array.isArray(data.inventory_health)?data.inventory_health:[];
  const staleRefills=Array.isArray(data.stale_refills)?data.stale_refills:[];
  const legacyCash=Array.isArray(data.legacy_cash)?data.legacy_cash:[];
  const vmsCleanup=Array.isArray(data.vms_cleanup)?data.vms_cleanup:[];
  const machines=machinesResult.data??[],locations=locationsResult.data??[];
  const missingMachineLocation=machines.filter((m:any)=>!m.location_id);
  const missingDistance=locations.filter((l:any)=>l.distance_from_storage_km===null||l.distance_from_storage_km===undefined);
  const currentCashCount=currentCashResult.count??0;

  const cards=[
    ["Machines missing site",missingMachineLocation.length,"/machines/setup"],
    ["Active sites missing distance",missingDistance.length,"/machines/setup"],
    ["Negative stock balances",Number(counts.negative_inventory??0),"#inventory-health"],
    ["Safe stale refill cancellations",Number(counts.safe_refill_cancellations??0),"#stale-refills"],
    ["Cash actions 3–30 days old",currentCashCount,"/cash-collections"],
    ["Recent VMS failures / partial",Number(counts.vms_recent_attention??0),"#vms-health"],
  ] as const;
  const activeCards=cards.filter(([,value])=>value>0);

  return <div className="space-y-6">
    <PageHeader title="Data Health" subtitle="Fix operational exceptions safely. Cleanup actions require owner/admin access and preserve audit context." action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/machines/setup">Machine setup</SecondaryButton><SecondaryButton href="/dashboard">Dashboard</SecondaryButton></div>}/>

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {activeCards.length?activeCards.map(([label,value,href])=><Link key={label} href={href} className="rounded-xl border border-rose-200 bg-rose-50 p-4"><div className="text-xs font-medium text-slate-500">{label}</div><div className="mt-1 text-3xl font-semibold">{value}</div><div className="mt-2 text-xs text-sky-800">Open records →</div></Link>):<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">No active data-health exceptions.</div>}
    </section>

    <section className="surface-card">
      <div className="mb-4"><h2 className="text-lg font-semibold">Machine & location setup</h2><p className="mt-1 text-sm text-slate-500">Every operating machine needs its real current site; every active site should have one-way distance from storage.</p></div>
      {!missingMachineLocation.length&&!missingDistance.length?<EmptyState title="Machine setup is complete" body="Every machine has a site and every active site has a distance."/>:
      <div className="grid gap-5 xl:grid-cols-2">
        <div><h3 className="mb-2 font-medium">Machines without site</h3>{missingMachineLocation.map((m:any)=><div key={m.id} className="mb-2 rounded-lg border p-3"><strong>{m.name}</strong><p className="text-xs text-slate-500">{m.machine_code} · {m.status}</p></div>)}</div>
        <div><h3 className="mb-2 font-medium">Sites missing distance</h3>{missingDistance.map((l:any)=><div key={l.id} className="mb-2 rounded-lg border p-3"><strong>{l.name}</strong><p className="text-xs text-slate-500">{l.address??"No address recorded"}</p></div>)}</div>
      </div>}
    </section>

    <section className="surface-card" id="inventory-health">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Inventory integrity</h2><p className="mt-1 text-sm text-slate-500">A negative balance becomes an audit case. Snacky OS never invents stock to make the warning disappear.</p></div>
        <div className="flex flex-wrap gap-2"><DataHealthActionButton action="scan_negative_inventory" label="Scan / refresh cases" requiresReason={false}/><SecondaryButton href="/inventory/reconciliation">Inventory reconciliation</SecondaryButton></div>
      </div>
      {!inventoryHealth.length?<EmptyState title="No open inventory health cases" body="Scan when a negative balance appears; corrected cases stay open until you close them with a note."/>:
      <DataTable headers={["Location","Product","Current qty","Case","Action"]}>{inventoryHealth.slice(0,50).map((row:any,index:number)=><tr key={row.case_id??[row.location_type,row.location_id,row.product_id,index].join("-")}>
        <td><div className="font-medium">{row.location_name??"-"}</div><div className="text-xs text-slate-500">{row.location_type}</div></td>
        <td>{row.product_name}</td>
        <td className={Number(row.current_quantity??0)<0?"font-semibold text-rose-700":"font-semibold text-emerald-700"}>{row.current_quantity??0}</td>
        <td>{row.case_id?<StatusBadge status={row.ready_to_resolve?"corrected_waiting_close":"open"}/>:<span className="text-xs text-amber-700">Scan cases first</span>}</td>
        <td>{row.ready_to_resolve&&row.case_id?<DataHealthActionButton action="resolve_inventory_case" targetId={row.case_id} label="Close corrected case" defaultReason="Physical and ledger balance verified after correction"/>:row.case_id&&row.location_type==="operator_bag"&&Number(row.current_quantity??0)<0?<OperatorBagReconcileControl caseId={row.case_id} currentQty={Number(row.current_quantity??0)} operatorName={row.location_name??"Operator"} productName={row.product_name??"Product"}/>:<Link className="link-secondary" href="/inventory/reconciliation">Review inventory</Link>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card" id="stale-refills">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Stale refill orders</h2><p className="mt-1 text-sm text-slate-500">{Number(counts.safe_refill_cancellations??0)>0?Number(counts.safe_refill_cancellations)+" can be cancelled safely. ":""}{Number(counts.picked_refill_review??0)>0?Number(counts.picked_refill_review)+" picked orders remain review-only because physical custody may already exist.":""}</p></div>{Number(counts.safe_refill_cancellations??0)>0?<DataHealthActionButton action="bulk_cancel_stale_refills" label={"Cancel all "+Number(counts.safe_refill_cancellations)+" safe stale refills"} defaultReason="Bulk cleanup of obsolete refill orders with no inventory movement and no active route"/>:null}</div>
      {!staleRefills.length?<EmptyState title="No stale refill work" body="All unfinished refill orders are recent."/>:
      <DataTable headers={["Generated","Machine","Refill","Route","Ledger","Action"]}>{staleRefills.slice(0,50).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.generated_at)}</td><td>{row.machine_name??row.machine_code??row.machine_id??"-"}</td><td><StatusBadge status={row.status}/></td>
        <td>{row.route_id?<><StatusBadge status={row.route_status??"unknown"}/> <Link className="link-secondary" href={"/routes/"+row.route_id}>Route</Link></>:"No route"}</td>
        <td>{row.has_movements?"Inventory movements exist":"No linked inventory movement"}</td>
        <td>{row.can_cancel?<DataHealthActionButton action="cancel_stale_refill" targetId={row.id} label="Cancel stale refill" defaultReason="Obsolete refill order; no inventory movement and no active route"/>:<span className="text-xs font-medium text-amber-700">{row.status==="picked"?"Picked stock requires manual inventory review":"Cancellation blocked by safety checks"}</span>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Cash backlog classification</h2><p className="mt-1 text-sm text-slate-500">Classification does not reconcile cash, change amounts, or post Finance. It only separates historical backlog from current controls.</p></div><SecondaryButton href="/cash-collections">Open cash</SecondaryButton></div>
      {(currentCashCount>0||Number(counts.legacy_cash_unclassified??0)>0||Number(counts.legacy_cash_classified??0)>0)?<div className="mb-4 grid gap-3 sm:grid-cols-3">{currentCashCount>0?<div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="text-xs">Current 3–30 day actions</div><strong className="text-2xl">{currentCashCount}</strong></div>:null}{Number(counts.legacy_cash_unclassified??0)>0?<div className="rounded-xl border p-3"><div className="text-xs">Legacy unclassified</div><strong className="text-2xl">{Number(counts.legacy_cash_unclassified)}</strong></div>:null}{Number(counts.legacy_cash_classified??0)>0?<div className="rounded-xl border bg-slate-50 p-3"><div className="text-xs">Legacy classified</div><strong className="text-2xl">{Number(counts.legacy_cash_classified)}</strong></div>:null}</div>:null}
      {!legacyCash.length?<EmptyState title="No legacy cash backlog" body="Older unresolved cash has been cleared or classified."/>:
      <DataTable headers={["Collected","Custody","Reconciliation","Counted","Expected","Classification","Action"]}>{legacyCash.slice(0,50).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.collected_at)}</td><td><StatusBadge status={row.custody_status}/></td><td><StatusBadge status={row.reconciliation_status}/></td><td>{row.actual_cash_collected??"-"}</td><td>{row.vms_expected_cash??"-"}</td>
        <td>{row.classification==="legacy_backlog"?<><strong>Legacy backlog</strong><div className="text-xs text-slate-500">{row.classification_reason}</div></>:"Unclassified"}</td>
        <td>{row.classification==="legacy_backlog"?<DataHealthActionButton action="unclassify_legacy_cash" targetId={row.id} label="Restore to legacy queue" requiresReason={false}/>:<DataHealthActionButton action="classify_legacy_cash" targetId={row.id} label="Mark legacy backlog" defaultReason="Historical record predates current cash reconciliation controls"/>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card" id="vms-health">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">VMS health & cleanup</h2><p className="mt-1 text-sm text-slate-500">Only old, inactive batches with zero imported rows can be archived here. Recent partial imports stay visible for repair.</p></div><div className="flex flex-wrap gap-2">{Number(counts.vms_cleanup_candidates??0)>0?<DataHealthActionButton action="bulk_archive_vms_batches" label={"Archive all "+Number(counts.vms_cleanup_candidates)+" safe batches"} defaultReason="Bulk cleanup of abandoned inactive zero-import VMS batches"/>:null}<SecondaryButton href="/vms-import">Open VMS imports</SecondaryButton></div></div>
      {(Number(counts.vms_recent_attention??0)>0||Number(counts.vms_cleanup_candidates??0)>0)?<div className="mb-4 grid gap-3 sm:grid-cols-2">{Number(counts.vms_recent_attention??0)>0?<div className="rounded-xl border border-rose-200 bg-rose-50 p-3"><div className="text-xs">Recent failures / partial / warnings</div><strong className="text-2xl">{Number(counts.vms_recent_attention)}</strong></div>:null}{Number(counts.vms_cleanup_candidates??0)>0?<div className="rounded-xl border p-3"><div className="text-xs">Safe archive candidates</div><strong className="text-2xl">{Number(counts.vms_cleanup_candidates)}</strong></div>:null}</div>:null>
      {!vmsCleanup.length?<EmptyState title="No VMS cleanup items" body="There are no recent problem batches or old abandoned batches."/>:
      <DataTable headers={["Uploaded","File","Type","Status","Imported","Errors","Review","Action"]}>{vmsCleanup.slice(0,60).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.uploaded_at)}</td><td>{row.original_file_name??row.file_name??"-"}</td><td>{row.report_type??"-"}</td><td><StatusBadge status={row.status}/></td><td>{Number(row.rows_imported??0)}</td><td>{Number(row.error_count??0)}</td><td>{Number(row.rows_needing_review??0)}</td>
        <td>{row.can_archive?<DataHealthActionButton action="archive_vms_batch" targetId={row.id} label="Archive abandoned batch" defaultReason="Abandoned zero-import VMS batch; archived from Data Health"/>:<Link className="link-secondary" href={"/vms-import/"+row.id}>Review batch</Link>}</td>
      </tr>)}</DataTable>}
    </section>
  </div>;
}
