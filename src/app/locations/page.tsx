import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { formatSiteLabel } from "@/lib/machine-site-display";
import { locationPayrollDistanceKm } from "@/lib/payroll";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";

type StorageLocationRow = {
  id: string;
  name?: string | null;
};

type LocationListRow = {
  id: string;
  name?: string | null;
  site_name?: string | null;
  area?: string | null;
  city?: string | null;
  location_type?: string | null;
  payroll_storage_location_id?: string | null;
  use_round_trip_distance?: boolean | null;
  status?: string | null;
  distance_from_storage_km?: number | string | null;
};

type LocationsSearchParams = SearchParamsRecord & {
  success?: string;
  error?: string;
};

function notice(message: string, tone: "success" | "error") {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`mb-5 rounded-lg border p-4 text-sm font-medium ${styles}`}>{message}</div>;
}

export default async function LocationsPage({ searchParams }: { searchParams: Promise<LocationsSearchParams> }) {
  const params = cleanSearchParams(await searchParams) as LocationsSearchParams;
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
        <>
          {params.success ? notice(String(params.success), "success") : null}
          {params.error ? notice(String(params.error), "error") : null}
          <EmptyState title="No locations yet" body="Create site locations before linking machines, rent, and payroll distance settings." action={<PrimaryButton href="/locations/new">Add location</PrimaryButton>} />
        </>
      ) : (
        <>
          {params.success ? notice(String(params.success), "success") : null}
          {params.error ? notice(String(params.error), "error") : null}
          <DataTable headers={["Site", "Area / Type", "Payroll km", "Round trip", "Storage", "Status", "Actions"]}>
            {(data as LocationListRow[]).map((location) => {
              const payrollKm = locationPayrollDistanceKm(location);
              const storageName = location.payroll_storage_location_id ? storageById.get(String(location.payroll_storage_location_id)) ?? "Unknown storage" : "-";
              return (
                <tr key={location.id}>
                  <td className="font-medium text-slate-900">
                    <div>{formatSiteLabel(location, { includeArea: true, fallback: location.name ?? "Unknown site" })}</div>
                    <div className="text-xs text-slate-500">{location.location_type}</div>
                    {payrollKm === null ? <div className="text-xs text-amber-700">Missing payroll distance</div> : null}
                  </td>
                  <td>{location.area ?? location.location_type}</td>
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
