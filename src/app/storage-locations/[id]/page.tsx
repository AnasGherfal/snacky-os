import Link from "next/link";
import { redirect } from "next/navigation";
import { Pencil, RotateCcw } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { activateStorageLocation, archiveStorageLocation, deleteStorageLocation } from "@/lib/storage-location-actions";
import {
  InventoryLocationRow,
  movementBelongsToLocation,
  StorageLocationRow,
  storageLocationStatusLabel,
  storageLocationTypeLabel,
  summarizeStorageLocation,
} from "@/lib/storage-locations";

export const dynamic = "force-dynamic";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function entityTypeLabel(type: string | null | undefined) {
  return type ? type.replaceAll("_", " ") : "-";
}

function entityLabel(type: string | null | undefined, id: string | null | undefined, maps: { storageById: Map<string, any>; operatorById: Map<string, any> }) {
  if (!type || !id) return "-";
  if (type === "storage") return maps.storageById.get(id)?.name ?? id.slice(0, 8);
  if (type === "operator_bag") return maps.operatorById.get(id)?.full_name ?? id.slice(0, 8);
  return id.slice(0, 8);
}

export default async function StorageLocationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile.role)) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Storage location unavailable" body="Supabase is not configured, so Snacky OS cannot load this storage location." />
      </>
    );
  }

  const [
    { data: location, error: locationError },
    { data: inventoryRows, error: inventoryError },
    { data: movements, error: movementsError },
    { data: allStorageLocations },
    { data: operators },
  ] = await Promise.all([
    supabase.from("storage_locations").select("id, name, address, active, location_type, related_operator_id, created_at, updated_at").eq("id", id).maybeSingle(),
    supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand"),
    supabase
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, created_by, notes, created_at, product:products(id, sku, name), created_by_member:team_members(id, full_name)")
      .order("created_at", { ascending: false }),
    supabase.from("storage_locations").select("id, name"),
    supabase.from("team_members").select("id, full_name, email, phone, role").order("full_name"),
  ]);

  const setupError = locationError ?? inventoryError ?? movementsError;
  if (setupError) {
    console.error("[storage-locations] Failed to load detail page", setupError);
    return (
      <>
        <ErrorState title="Could not load storage location" body="Snacky OS could not load this location, its inventory, or movement history." />
      </>
    );
  }

  if (!location) {
    return (
      <>
        <EmptyState title="Storage location not found" body="This location may have been deleted or archived from another session." />
      </>
    );
  }

  const typedLocation = location as StorageLocationRow;
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const storageById = new Map((allStorageLocations ?? []).map((storage: any) => [storage.id, storage]));
  const relatedOperator = typedLocation.related_operator_id ? operatorById.get(typedLocation.related_operator_id) : null;
  const summary = summarizeStorageLocation(typedLocation, inventoryRows ?? [], movements ?? []);
  const locationInventory = ((inventoryRows ?? []) as InventoryLocationRow[])
    .filter((row) => {
      if (typedLocation.location_type === "operator_bag") return row.location_type === "operator_bag" && row.location_id === typedLocation.related_operator_id;
      if (typedLocation.location_type === "damaged" || typedLocation.location_type === "expired") return false;
      return row.location_type === "storage" && row.location_id === typedLocation.id;
    })
    .sort((a, b) => String(a.product_name ?? "").localeCompare(String(b.product_name ?? "")));
  const locationMovements = (movements ?? []).filter((movement: any) => movementBelongsToLocation(movement, typedLocation));
  const canHardDelete = summary.movementCount === 0 && summary.totalUnits === 0;

  return (
    <>
      <PageHeader
        title={typedLocation.name}
        subtitle="Storage location inventory, related operator, and ledger movement history."
        breadcrumbs={[
          { label: "Inventory", href: "/inventory" },
          { label: "Storage Locations", href: "/storage-locations" },
          { label: typedLocation.name },
        ]}
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/storage-locations">Back</SecondaryButton><SecondaryButton href={`/storage-locations/${typedLocation.id}/edit`}><Pencil className="mr-2 h-4 w-4" />Edit</SecondaryButton></div>}
      />

      {query.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="surface-card">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Type</div>
              <div className="mt-1 text-sm font-medium text-slate-900">{storageLocationTypeLabel(typedLocation.location_type)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
              <div className="mt-1"><StatusBadge status={storageLocationStatusLabel(typedLocation.active)} /></div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current Products</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{summary.productCount}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current Units</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{summary.totalUnits}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Address / Notes</div>
              <p className="mt-1 text-sm text-slate-600">{typedLocation.address || "-"}</p>
            </div>
          </div>
        </section>

        <section className="surface-card">
          <h2 className="text-base font-semibold text-slate-900">Related Operator</h2>
          {relatedOperator ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div><dt className="text-slate-500">Name</dt><dd className="font-medium text-slate-900">{relatedOperator.full_name}</dd></div>
              <div><dt className="text-slate-500">Email</dt><dd>{relatedOperator.email ?? "-"}</dd></div>
              <div><dt className="text-slate-500">Phone</dt><dd>{relatedOperator.phone ?? "-"}</dd></div>
              <div><dt className="text-slate-500">Role</dt><dd>{relatedOperator.role ?? "-"}</dd></div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No operator is linked to this location.</p>
          )}
        </section>
      </div>

      <section className="surface-card mb-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Current Inventory</h2>
            <p className="text-sm text-slate-500">Calculated from inventory_movements; stock is not edited directly.</p>
          </div>
        </div>
        {!locationInventory.length ? (
          <EmptyState title="No current inventory in this location" body="Inventory will appear when movements put stock into this location." />
        ) : (
          <DataTable headers={["Product", "Quantity"]}>
            {locationInventory.map((row) => (
              <tr key={`${row.product_id}-${row.location_id}`}>
                <td>
                  <Link href={`/products/${row.product_id}`} className="link-secondary font-semibold">
                    {row.product_name ?? "Unknown product"}
                  </Link>
                </td>
                <td className="font-semibold text-slate-900">{Number(row.quantity_on_hand ?? 0)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Movement History</h2>
          <p className="text-sm text-slate-500">Ledger entries that moved stock into or out of this location.</p>
        </div>
        {!locationMovements.length ? (
          <EmptyState title="No movement history" body="This location can be hard-deleted while it has no movement history and no current inventory." />
        ) : (
          <DataTable headers={["Date", "Product", "Qty", "From", "To", "Reason", "User", "Notes"]}>
            {locationMovements.map((movement: any) => (
              <tr key={movement.id}>
                <td>{formatDate(movement.created_at)}</td>
                <td>{movement.product?.name ?? "Unknown product"}<div className="text-xs text-slate-500">{movement.product?.sku ?? "-"}</div></td>
                <td className="font-semibold">{movement.quantity}</td>
                <td><span className="font-medium">{entityTypeLabel(movement.from_entity_type)}</span><div className="text-xs text-slate-500">{entityLabel(movement.from_entity_type, movement.from_entity_id, { storageById, operatorById })}</div></td>
                <td><span className="font-medium">{entityTypeLabel(movement.to_entity_type)}</span><div className="text-xs text-slate-500">{entityLabel(movement.to_entity_type, movement.to_entity_id, { storageById, operatorById })}</div></td>
                <td><StatusBadge status={String(movement.reason ?? "").replaceAll("_", " ")} /></td>
                <td>{movement.created_by_member?.full_name ?? "-"}</td>
                <td>{movement.notes ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="surface-card">
        <h2 className="text-base font-semibold text-slate-900">Location Controls</h2>
        <p className="mt-1 text-sm text-slate-500">Locations with inventory or movement history are archived instead of hard-deleted.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {typedLocation.active ? (
            <ConfirmDialog
              action={archiveStorageLocation}
              triggerLabel="Archive location"
              title="Archive storage location?"
              description="Archived locations stay available in history, but they cannot be selected for new movements."
              confirmLabel="Archive location"
              buttonClassName="btn-secondary"
              hiddenFields={[{ name: "id", value: typedLocation.id }]}
            />
          ) : (
            <form action={activateStorageLocation}>
              <input type="hidden" name="id" value={typedLocation.id} />
              <button className="btn-secondary"><RotateCcw className="mr-2 h-4 w-4" />Activate location</button>
            </form>
          )}
          {canHardDelete ? (
            <ConfirmDialog
              action={deleteStorageLocation}
              triggerLabel="Delete permanently"
              title="Delete storage location permanently?"
              description="This location has no current inventory and no movement history, so it can be removed."
              confirmLabel="Delete permanently"
              buttonClassName="btn-danger"
              confirmButtonClassName="btn-danger"
              hiddenFields={[{ name: "id", value: typedLocation.id }]}
            />
          ) : (
            <span className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-600">
              Hard delete disabled: inventory or movement history exists.
            </span>
          )}
        </div>
      </section>
    </>
  );
}
