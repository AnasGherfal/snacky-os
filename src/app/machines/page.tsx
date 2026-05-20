import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function MachinesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const s = getSupabaseServerClient();
  if (!s) {
    return (
      <>
        <ErrorState title="Machines unavailable" body="Supabase is not configured, so Snacky OS cannot load machines." />
      </>
    );
  }
  const query = s?.from("machines").select("id,machine_code,vms_machine_id,name,status,machine_type,locations(name)").order("name");
  const { data, error } = query ? (q ? await query.ilike("name", `%${q}%`) : await query) : { data: [], error: null };
  if (error) {
    console.error("[machines] Failed to load machines", error);
    return (
      <>
        <ErrorState title="Could not load machines" body="Snacky OS could not load real machine records from Supabase." action={<SecondaryButton href="/machines">Retry</SecondaryButton>} />
      </>
    );
  }

  return <><PageHeader title="Machines" subtitle="Machine master records, targets, and installation context." action={<PrimaryButton href="/machines/new">Add machine</PrimaryButton>} />
    <form className="mb-4"><SearchInput placeholder="Search by machine name..." /></form>
    {!data?.length ? <EmptyState title="No machines yet" body="Create your first machine to start refill and route planning." /> :
      <DataTable headers={["Code","Name","Type","Location","Status","Actions"]}>{data.map((m:any)=><tr key={m.id}><td>{m.machine_code}</td><td className="font-medium">{m.name}</td><td>{m.machine_type}</td><td>{m.locations?.name ?? "-"}</td><td><StatusBadge status={m.status} /></td><td><Link href={`/machines/${m.id}/edit`} className="btn-secondary">Edit</Link></td></tr>)}</DataTable>}
  </>;
}
