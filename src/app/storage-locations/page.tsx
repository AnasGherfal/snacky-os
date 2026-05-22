import Link from "next/link";
import { redirect } from "next/navigation";
import { Eye, Pencil, Plus, RotateCcw } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { activateStorageLocation, archiveStorageLocation, deleteStorageLocation } from "@/lib/storage-location-actions";
import {
  StorageLocationRow,
  storageLocationStatusLabel,
  storageLocationTypeHelpers,
  storageLocationTypeLabel,
  summarizeStorageLocation,
} from "@/lib/storage-locations";

export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default async function StorageLocationsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Storage locations unavailable" body="Supabase is not configured, so Snacky OS cannot load storage location data." />
      </>
    );
  }

  const [{ data: locations, error: locationsError }, { data: inventoryRows, error: inventoryError }, { data: movements, error: movementsError }, { data: operators }] =
    await Promise.all([
      supabase.from("storage_locations").select("id, name, address, active, location_type, related_operator_id, created_at, updated_at").order("name"),
      supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand"),
      supabase.from("inventory_movements").select("id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, created_at").order("created_at", { ascending: false }),
      supabase.from("team_members").select("id, full_name, email").order("full_name"),
    ]);

  const setupError = locationsError ?? inventoryError ?? movementsError;
  if (setupError) {
    console.error("[storage-locations] Failed to load page data", setupError);
    return (
      <>
        <ErrorState title="Could not load storage locations" body="Snacky OS could not load the storage location summary from Supabase." />
      </>
    );
  }

  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const rows = ((locations ?? []) as StorageLocationRow[])
    .map((location) => ({
      location,
      operator: location.related_operator_id ? operatorById.get(location.related_operator_id) : null,
      summary: summarizeStorageLocation(location, inventoryRows ?? [], movements ?? []),
    }))
    .sort((a, b) => Number(b.location.active) - Number(a.location.active) || storageLocationTypeLabel(a.location.location_type).localeCompare(storageLocationTypeLabel(b.location.location_type)) || a.location.name.localeCompare(b.location.name));

  const activeCount = rows.filter((row) => row.location.active).length;
  const archivedCount = rows.length - activeCount;
  const totalUnits = rows.reduce((sum, row) => sum + row.summary.totalUnits, 0);

  return (
    <>
      <PageHeader
        title="Storage Locations"
        subtitle="Manage warehouses, operator bags, and internal stock locations used by inventory movements."
        action={<PrimaryButton href="/storage-locations/new"><Plus className="mr-2 h-4 w-4" />Add location</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active Locations</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{activeCount}</div>
          <p className="mt-1 text-sm text-slate-500">{archivedCount} archived</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current Units</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{totalUnits}</div>
          <p className="mt-1 text-sm text-slate-500">Calculated from inventory_movements</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Location Types</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{new Set(rows.map((row) => row.location.location_type ?? "main_storage")).size}</div>
          <p className="mt-1 text-sm text-slate-500">Warehouses, bags, vehicles, and internal locations</p>
        </div>
      </div>

      <section className="mb-6 grid gap-3 md:grid-cols-3">
        {storageLocationTypeHelpers.map((helper) => (
          <div key={helper.title} className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">{helper.title}</h2>
            <p className="mt-1 text-sm text-slate-500">{helper.body}</p>
          </div>
        ))}
      </section>

      {!rows.length ? (
        <EmptyState title="No storage locations yet" body="Add MAIN storage, operator bags, or temporary stock locations before creating inventory movements." />
      ) : (
        <DataTable headers={["Location Name", "Type", "Status", "Current Products Count", "Current Total Units", "Last Movement Date", "Actions"]}>
          {rows.map(({ location, operator, summary }) => {
            const canHardDelete = summary.movementCount === 0 && summary.totalUnits === 0;
            return (
              <tr key={location.id}>
                <td>
                  <Link href={`/storage-locations/${location.id}`} className="link-secondary font-semibold">
                    {location.name}
                  </Link>
                  {operator ? <div className="mt-1 text-xs text-slate-500">{operator.full_name}</div> : null}
                </td>
                <td>{storageLocationTypeLabel(location.location_type)}</td>
                <td><StatusBadge status={storageLocationStatusLabel(location.active)} /></td>
                <td>{summary.productCount}</td>
                <td className="font-semibold text-slate-900">{summary.totalUnits}</td>
                <td>{formatDate(summary.lastMovementAt)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/storage-locations/${location.id}`} className="btn-secondary px-3 py-2"><Eye className="mr-2 h-4 w-4" />View</Link>
                    <Link href={`/storage-locations/${location.id}/edit`} className="btn-secondary px-3 py-2"><Pencil className="mr-2 h-4 w-4" />Edit</Link>
                    {location.active ? (
                      <ConfirmDialog
                        action={archiveStorageLocation}
                        triggerLabel="Archive"
                        title="Archive storage location?"
                        description="Archived locations stay in movement history but cannot be used for new stock movements."
                        confirmLabel="Archive location"
                        buttonClassName="btn-secondary px-3 py-2"
                        hiddenFields={[{ name: "id", value: location.id }]}
                      />
                    ) : (
                      <form action={activateStorageLocation}>
                        <input type="hidden" name="id" value={location.id} />
                        <button className="btn-secondary px-3 py-2"><RotateCcw className="mr-2 h-4 w-4" />Activate</button>
                      </form>
                    )}
                    {canHardDelete ? (
                      <ConfirmDialog
                        action={deleteStorageLocation}
                        triggerLabel="Delete"
                        title="Delete storage location permanently?"
                        description="This is only allowed because the location has no current inventory and no movement history."
                        confirmLabel="Delete permanently"
                        buttonClassName="btn-danger px-3 py-2"
                        confirmButtonClassName="btn-danger"
                        hiddenFields={[{ name: "id", value: location.id }]}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </>
  );
}
