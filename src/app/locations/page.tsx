import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function LocationsPage() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Locations unavailable" body="Supabase is not configured, so Snacky OS cannot load site locations." />
      </>
    );
  }

  const { data, error } = await supabase.from("locations").select("id,name,location_type,rent_amount,status").order("name");
  if (error) {
    console.error("[locations] Failed to load locations", error);
    return (
      <>
        <ErrorState title="Could not load locations" body="Snacky OS could not load site location records from Supabase." action={<SecondaryButton href="/locations">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Locations"
        subtitle="Manage customer sites, venue records, rent context, and machine installation locations."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations" }]}
        action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>}
      />
      {!data?.length ? (
        <EmptyState title="No locations yet" body="Create site locations before linking machines, rent, and operating context." action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>} />
      ) : (
        <DataTable headers={["Name", "Type", "Rent", "Status", "Actions"]}>
          {data.map((location: any) => (
            <tr key={location.id}>
              <td className="font-medium text-slate-900">{location.name}</td>
              <td>{location.location_type}</td>
              <td>{Number(location.rent_amount || 0).toFixed(2)}</td>
              <td><StatusBadge status={location.status} /></td>
              <td><Link className="btn-secondary" href={`/locations/${location.id}`}>Edit</Link></td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
