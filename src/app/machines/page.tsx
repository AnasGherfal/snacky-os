import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
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
  let query = s.from("machines").select("id,machine_code,vms_machine_id,name,status,machine_type,locations(name)", { count: "exact" }).order("name");
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

  return <><PageHeader title="Machines" subtitle="Machine master records, targets, and installation context." action={<PrimaryButton href="/machines/new">Add machine</PrimaryButton>} />
    <form className="mb-4 flex flex-wrap gap-2">
      <input type="hidden" name="pageSize" value={pageSize} />
      <SearchInput defaultValue={q} placeholder="Search by machine name or code..." />
      <button className="btn-secondary" type="submit">Search</button>
    </form>
    {!data?.length ? <EmptyState title="No machines yet" body="Create your first machine to start refill and route planning." /> :
      <>
        <DataTable headers={["Code","Name","Type","Location","Status","Actions"]}>{data.map((m:any)=><tr key={m.id}><td>{m.machine_code}</td><td className="font-medium">{m.name}</td><td>{m.machine_type}</td><td>{m.locations?.name ?? "-"}</td><td><StatusBadge status={m.status} /></td><td><Link href={`/machines/${m.id}/edit`} className="btn-secondary">Edit</Link></td></tr>)}</DataTable>
        <PaginationControls basePath="/machines" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="machines" />
      </>}
  </>;
}
