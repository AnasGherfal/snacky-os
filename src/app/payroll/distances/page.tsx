import { redirect } from "next/navigation";
import { EmptyState, ErrorState, FormField, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { locationPayrollDistanceKm } from "@/lib/payroll";
import { saveLocationPayrollDistance } from "@/lib/payroll-v2-actions";
import { getPayrollV2ServerClient } from "@/lib/payroll-v2";

export const dynamic = "force-dynamic";

type MachineSummaryRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location_id?: string | null;
};

type StorageLocationRow = {
  id: string;
  name?: string | null;
};

export default async function PayrollDistancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Payroll distance unavailable" body="Supabase is not configured, so Snacky OS cannot load location payroll distance." />
      </>
    );
  }

  const [{ data: locations, error: locationsError }, { data: machines, error: machinesError }, { data: storageLocations, error: storageError }] = await Promise.all([
    supabase.from("locations").select("*").eq("status", "active").order("name"),
    supabase.from("machines").select("id, name, machine_code, location_id").order("name"),
    supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
  ]);

  if (locationsError || machinesError || storageError) {
    console.error("[payroll:distances] Failed to load payroll distance page", { locationsError, machinesError, storageError });
    return (
      <>
        <ErrorState
          title="Could not load payroll distance"
          body="Snacky OS could not load active locations and storage distance setup."
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />
      </>
    );
  }

  const machinesByLocationId = ((machines ?? []) as MachineSummaryRow[]).reduce((map, machine) => {
    const key = String(machine.location_id ?? "");
    if (!key) return map;
    const rows = map.get(key) ?? [];
    rows.push(machine);
    map.set(key, rows);
    return map;
  }, new Map<string, MachineSummaryRow[]>());

  return (
    <>
      <PageHeader
        title="Location Payroll Distance / مسافة المواقع"
        subtitle="Manual KM is enough for now. Missing distance never blocks payroll, but those stops are calculated as 0 km until fixed."
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Location payroll distance" }]}
        action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Location payroll distance saved.</div> : null}

      {!locations?.length ? (
        <EmptyState title="No active locations" body="Active locations will appear here once Snacky has machine sites to configure." />
      ) : (
        <div className="grid gap-4">
          {locations.map((location: any) => {
            const machineList = machinesByLocationId.get(String(location.id)) ?? [];
            const payrollKm = locationPayrollDistanceKm(location);
            return (
              <section key={location.id} className="surface-card rounded-2xl border border-slate-200">
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-900">{location.name}</h2>
                      <StatusBadge status={payrollKm === null ? "missing_distance" : "configured"} />
                    </div>
                    <div className="mt-2 text-sm text-slate-500">
                      {machineList.length
                        ? machineList.map((machine) => `${machine.name ?? "Unknown machine"}${machine.machine_code ? ` (${machine.machine_code})` : ""}`).join(", ")
                        : "No machine linked yet"}
                    </div>
                    {payrollKm === null ? (
                      <div className="mt-2 text-sm font-medium text-amber-700">Missing distance. Payroll will calculate this location as 0 km until it is saved.</div>
                    ) : (
                      <div className="mt-2 text-sm font-medium text-slate-700">Current payroll distance: {payrollKm.toFixed(2)} km</div>
                    )}
                  </div>
                  <SecondaryButton href={`/locations/${location.id}`}>Open full location record</SecondaryButton>
                </div>

                <form action={saveLocationPayrollDistance} className="grid gap-4 lg:grid-cols-5">
                  <input type="hidden" name="location_id" value={location.id} />
                  <FormField label="Storage location">
                    <select name="payroll_storage_location_id" defaultValue={location.payroll_storage_location_id ?? ""} className="field-input">
                      <option value="">No storage selected</option>
                      {(storageLocations ?? []).map((storageLocation: StorageLocationRow) => (
                        <option key={storageLocation.id} value={storageLocation.id}>{storageLocation.name}</option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Distance from storage km">
                    <input type="number" name="distance_from_storage_km" min="0" step="0.01" defaultValue={location.distance_from_storage_km ?? ""} className="field-input" />
                  </FormField>
                  <FormField label="Round trip">
                    <select name="use_round_trip_distance" defaultValue={location.use_round_trip_distance ? "yes" : "no"} className="field-input">
                      <option value="no">One way</option>
                      <option value="yes">Round trip</option>
                    </select>
                  </FormField>
                  <FormField label="Payroll km">
                    <input readOnly value={payrollKm === null ? "0.00 until fixed" : `${payrollKm.toFixed(2)} km`} className="field-input bg-slate-50" />
                  </FormField>
                  <FormField label="Notes">
                    <input name="payroll_distance_notes" defaultValue={location.payroll_distance_notes ?? ""} className="field-input" placeholder="Optional storage or route note" />
                  </FormField>
                  <div className="lg:col-span-5">
                    <PrimaryButton>Save distance</PrimaryButton>
                  </div>
                </form>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
