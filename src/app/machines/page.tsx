import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { formatMachineDisplayName, formatSiteLabel } from "@/lib/machine-site-display";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

export default async function MachinesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { q?: string }> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const q = String(params.q ?? "");
  const s = await getAuthenticatedSupabaseServerClient();
  if (!s) {
    return (
      <>
        <ErrorState title="Machines unavailable" body="Supabase is not configured, so Snacky OS cannot load machines." />
      </>
    );
  }
  let query = s.from("machines").select("*, locations(*)", { count: "exact" }).order("machine_code");
  if (q.trim()) {
    const pattern = supabaseLikePattern(q.replaceAll(",", " "));
    query = query.or(["name", "machine_code", "vms_machine_id", "machine_type"].map((column) => `${column}.ilike.${pattern}`).join(","));
  }
  const { data, count, error } = await query.range(from, to);
  if (error) {
    console.error("[machines] Failed to load machines", error);
    return (
      <>
        <ErrorState title="Could not load machines" body="Snacky OS could not load real machine records from Supabase." action={<SecondaryButton href="/machines">Retry</SecondaryButton>} />
      </>
    );
  }

  const missingSiteCount=(data??[]).filter((m:any)=>!m.location_id).length;

  const xyState=(m:any)=>{
    if(!m.vms_machine_id)return {label:"No XY",status:"not_connected"};
    if(!m.last_vms_status_at&&!m.vms_last_synced_at)return {label:"Never synced",status:"needs_review"};
    const online=String(m.vms_online_status??"")==="1";
    return {label:online?"XY Online":"XY Offline",status:online?"active":"offline"};
  };

  return <><PageHeader title="Machines" subtitle="Machine master records, targets, and installation context." action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/machines/setup">{"Machine setup"+(missingSiteCount?" · "+missingSiteCount+" missing site":"")}</SecondaryButton><PrimaryButton href="/machines/new">Add machine</PrimaryButton></div>} />
    <form className="mb-4 flex flex-wrap gap-2">
      <input type="hidden" name="pageSize" value={pageSize} />
      <SearchInput defaultValue={q} placeholder="Search by machine code or display label..." />
      <button className="btn-secondary" type="submit">Search</button>
    </form>
    {!data?.length ? <EmptyState title="No machines yet" body="Create your first machine to start refill and route planning." /> :
      <>
        <DataTable headers={["Code","Machine","Type","Site","Snacky","XY status","Actions"]}>{data.map((m:any)=><tr key={m.id}><td>{m.machine_code}</td><td className="font-medium"><div>{formatMachineDisplayName(m, { includeArea: false })}</div><div className="text-xs text-slate-500">{m.vms_machine_id || "No VMS ID"}</div></td><td>{m.machine_type}</td><td>{formatSiteLabel(m.locations, { includeArea: true, fallback: "-" })}</td><td><StatusBadge status={m.status} /></td><td><div><StatusBadge status={xyState(m).status} label={xyState(m).label}/><div className="mt-1 text-xs text-slate-500">{m.last_vms_status_at?new Date(m.last_vms_status_at).toLocaleString("en-US"):(m.vms_last_synced_at?new Date(m.vms_last_synced_at).toLocaleString("en-US"):"No XY contact")}</div></div></td><td><div className="flex flex-wrap gap-2"><Link href={`/machines/${m.id}`} className="link-secondary">History</Link><Link href={`/machines/${m.id}/edit`} className="btn-secondary">Edit</Link></div></td></tr>)}</DataTable>
        <PaginationControls basePath="/machines" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="machines" />
      </>}
  </>;
}
