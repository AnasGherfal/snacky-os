
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { formatSiteLabel } from "@/lib/machine-site-display";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function saveMachineSite(formData: FormData) {
  "use server";
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["owner","admin","supervisor"])) redirect("/unauthorized");
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return;

  const machineId=String(formData.get("machine_id")??"").trim();
  const locationId=String(formData.get("location_id")??"").trim();
  const distanceText=String(formData.get("distance_from_storage_km")??"").trim();
  if(!uuid.test(machineId)||!uuid.test(locationId))return;
  const distance=distanceText===""?null:Number(distanceText);
  if(distance!==null&&(!Number.isFinite(distance)||distance<0))return;

  const machineUpdate=await db.from("machines").update({location_id:locationId,updated_at:new Date().toISOString()}).eq("id",machineId).select("id").maybeSingle();
  if(machineUpdate.error||!machineUpdate.data){console.error("[machine-setup] Could not assign site",{machineId,locationId,error:machineUpdate.error});return;}

  if(distance!==null){
    const locationUpdate=await db.from("locations").update({distance_from_storage_km:distance,updated_at:new Date().toISOString()}).eq("id",locationId).select("id").maybeSingle();
    if(locationUpdate.error)console.error("[machine-setup] Machine assigned but distance update failed",{machineId,locationId,error:locationUpdate.error});
  }

  revalidatePath("/machines/setup");
  revalidatePath("/machines");
  revalidatePath("/machines-dashboard");
  revalidatePath("/operations-health");
  revalidatePath("/refills");
  revalidatePath("/payroll/distances");
}

export default async function MachineSetupPage(){
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!hasAnyRole(profile,["owner","admin","supervisor"]))redirect("/unauthorized");
  const db=await getAuthenticatedSupabaseServerClient();
  if(!db)return <EmptyState title="Machine setup unavailable" body="Database connection is unavailable."/>;
  const [{data:machines},{data:locations}]=await Promise.all([
    db.from("machines").select("id,machine_code,name,status,location_id,location:locations(id,name,address,distance_from_storage_km)").order("machine_code"),
    db.from("locations").select("id,name,address,status,distance_from_storage_km").eq("status","active").order("name"),
  ]);
  const rows=machines??[],sites=locations??[];
  const incomplete=rows.filter((m:any)=>!m.location_id);
  const missingDistance=sites.filter((l:any)=>l.distance_from_storage_km===null||l.distance_from_storage_km===undefined);

  return <div className="space-y-6">
    <PageHeader title="Machine Setup" subtitle="Assign each physical machine to its real current site. Distance is stored once on the site and shared by every machine there." action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/operations-health">Data Health</SecondaryButton><SecondaryButton href="/machines">Machines</SecondaryButton></div>}/>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs text-slate-500">Machines</div><strong className="mt-1 block text-3xl">{rows.length}</strong></div>
      <div className={"rounded-xl border p-4 "+(incomplete.length?"border-rose-200 bg-rose-50":"border-slate-200 bg-white")}><div className="text-xs text-slate-500">Missing site</div><strong className="mt-1 block text-3xl">{incomplete.length}</strong></div>
      <div className={"rounded-xl border p-4 "+(missingDistance.length?"border-amber-200 bg-amber-50":"border-slate-200 bg-white")}><div className="text-xs text-slate-500">Sites missing distance</div><strong className="mt-1 block text-3xl">{missingDistance.length}</strong></div>
    </div>

    <section className="surface-card">
      <div className="mb-4"><h2 className="text-lg font-semibold">Assign current sites</h2><p className="mt-1 text-sm text-slate-500">Save one machine at a time. Enter distance only when you know it; leaving distance blank will not overwrite an existing site distance.</p></div>
      {!rows.length?<EmptyState title="No machines" body="Create a machine first."/>:
      <div className="space-y-3">{rows.map((machine:any)=><form action={saveMachineSite} key={machine.id} className={"rounded-xl border p-4 "+(machine.location_id?"border-slate-200 bg-white":"border-rose-200 bg-rose-50")}>
        <input type="hidden" name="machine_id" value={machine.id}/>
        <div className="grid gap-3 lg:grid-cols-[1.3fr_1.5fr_1fr_auto] lg:items-end">
          <div><div className="font-semibold">{machine.name}</div><div className="mt-1 text-xs text-slate-500">{machine.machine_code} · <StatusBadge status={machine.status}/></div><div className="mt-1 text-xs">{machine.location_id?"Current: "+(machine.location?.name??"Linked site"):"No current site"}</div></div>
          <label className="text-sm font-medium">Current site<select name="location_id" required defaultValue={machine.location_id??""} className="field-input mt-1"><option value="">Choose site</option>{sites.map((site:any)=><option key={site.id} value={site.id}>{formatSiteLabel(site,{includeArea:true,fallback:site.name})+(site.distance_from_storage_km!==null&&site.distance_from_storage_km!==undefined?" · "+Number(site.distance_from_storage_km).toFixed(1)+" km":" · distance missing")}</option>)}</select></label>
          <label className="text-sm font-medium">One-way distance km<input name="distance_from_storage_km" type="number" min="0" step="0.01" placeholder={machine.location?.distance_from_storage_km??"Leave blank if unknown"} className="field-input mt-1"/></label>
          <button className="btn-primary min-h-11" type="submit">Save site</button>
        </div>
        <div className="mt-2 text-xs text-slate-500">Need other machine details? <Link className="link-secondary" href={"/machines/"+machine.id+"/edit"}>Open full edit</Link></div>
      </form>)}</div>}
    </section>

    {missingDistance.length?<section className="surface-card"><h2 className="text-lg font-semibold">Sites still missing distance</h2><div className="mt-3 grid gap-2 sm:grid-cols-2">{missingDistance.map((site:any)=><div key={site.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3"><div className="font-medium">{site.name}</div><div className="text-xs text-slate-500">{site.address??"No address recorded"}</div></div>)}</div></section>:null}
  </div>;
}
