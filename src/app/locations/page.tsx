import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DataTable, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function LocationsPage() {
  const s = getSupabaseServerClient();
  const { data } = s ? await s.from("locations").select("id,name,location_type,rent_amount,status").order("name") : { data: [] };
  return <AppShell><PageHeader title="Locations" subtitle="Manage real site master data from Supabase." action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>} />
    <DataTable headers={["Name","Type","Rent","Status","Actions"]}>{data?.map((r:any)=><tr key={r.id}><td>{r.name}</td><td>{r.location_type}</td><td>{Number(r.rent_amount||0).toFixed(2)}</td><td><StatusBadge status={r.status}/></td><td><Link className="btn-secondary" href={`/locations/${r.id}`}>Edit</Link></td></tr>)}</DataTable>
  </AppShell>;
}
