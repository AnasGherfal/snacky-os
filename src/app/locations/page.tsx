import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { locationPayrollDistanceKm } from "@/lib/payroll";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";

type StorageLocationRow = {
  id: string;
  name?: string | null;
};

export default async function LocationsPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Locations unavailable" body="Supabase is not configured, so Snacky OS cannot load site locations." />
      </>
    );
  }

  const [{ data, count, error }, { data: storageLocations }] = await Promise.all([
    supabase
      .from("locations")
      .select("*", { count: "exact" })
      .order("name")
      .range(from, to),
    supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
  ]);

  if (error) {
    console.error("[locations] Failed to load locations", error);
    return (
      <>
        <ErrorState title="Could not load locations" body="Snacky OS could not load site location records from Supabase." action={<SecondaryButton href="/locations">Retry</SecondaryButton>} />
      </>
    );
  }

  const storageById = new Map(((storageLocations ?? []) as StorageLocationRow[]).map((location) => [location.id, location.name ?? "Unknown storage"]));

  return (
    <>
      <PageHeader
        title="Locations"
        subtitle="Manage customer sites and the payroll distance that completed stops will use for route salary calculation."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations" }]}
        action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>}
      />
      {!data?.length ? (
        <EmptyState title="No locations yet" body="Create site locations before linking machines, rent, and payroll distance settings." action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>} />
      ) : (
        <>
          <DataTable headers={["Name", "Type", "Payroll km", "Round trip", "Storage", "Status", "Actions"]}>
            {data.map((location: any) => {
              const payrollKm = locationPayrollDistanceKm(location);
              const storageName = location.payroll_storage_location_id ? storageById.get(String(location.payroll_storage_location_id)) ?? "Unknown storage" : "-";
              return (
                <tr key={location.id}>
                  <td className="font-medium text-slate-900">
                    <div>{location.name}</div>
                    {payrollKm === null ? <div className="text-xs text-amber-700">Missing payroll distance</div> : null}
                  </td>
                  <td>{location.location_type}</td>
                  <td>{payrollKm === null ? "-" : `${payrollKm.toFixed(2)} km`}</td>
                  <td>{location.use_round_trip_distance ? "Yes" : "No"}</td>
                  <td>{storageName}</td>
                  <td><StatusBadge status={location.status} /></td>
                  <td><Link className="btn-secondary" href={`/locations/${location.id}`}>Edit</Link></td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/locations" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="locations" />
        </>
      )}
    </>
  );
}
