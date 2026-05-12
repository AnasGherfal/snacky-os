import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SearchInput, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function MachinesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const s = getSupabaseServerClient();
  const query = s?.from("machines").select("id,machine_code,vms_machine_id,name,status,machine_type,locations(name)").order("name");
  const { data } = query ? (q ? await query.ilike("name", `%${q}%`) : await query) : { data: [] };

  return <AppShell><PageHeader title="Machines" subtitle="Machine master records, targets, and installation context." action={<PrimaryButton href="/machines/new">Add machine</PrimaryButton>} />
    <form className="mb-4"><SearchInput placeholder="Search by machine name..." /></form>
    {!data?.length ? <EmptyState title="No machines yet" body="Create your first machine to start refill and route planning." /> :
      <DataTable headers={["Code","Name","Type","Location","Status","Actions"]}>{data.map((m:any)=><tr key={m.id}><td>{m.machine_code}</td><td className="font-medium">{m.name}</td><td>{m.machine_type}</td><td>{m.locations?.name ?? "-"}</td><td><StatusBadge status={m.status} /></td><td><Link href={`/machines/${m.id}/edit`} className="btn-secondary">Edit</Link></td></tr>)}</DataTable>}
  </AppShell>;
}
