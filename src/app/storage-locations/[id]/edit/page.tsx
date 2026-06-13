import { redirect } from "next/navigation";
import { StorageLocationForm } from "@/components/StorageLocationForm";
import { EmptyState, ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { updateStorageLocation } from "@/lib/storage-location-actions";
import { StorageLocationRow } from "@/lib/storage-locations";

export const dynamic = "force-dynamic";

export default async function EditStorageLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile)) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Storage location unavailable" body="Supabase is not configured, so Snacky OS cannot edit this storage location." />
      </>
    );
  }

  const [{ data: location, error: locationError }, { data: operators }] = await Promise.all([
    supabase.from("storage_locations").select("id, name, address, active, location_type, related_operator_id, latitude, longitude, created_at, updated_at").eq("id", id).maybeSingle(),
    supabase
      .from("team_members")
      .select("id, full_name, email, role, roles")
      .or("role.in.(operator,warehouse,supervisor),roles.ov.{operator,warehouse,supervisor}")
      .eq("active", true)
      .order("full_name"),
  ]);

  if (locationError) {
    console.error("[storage-locations] Failed to load edit page", locationError);
    return (
      <>
        <ErrorState title="Could not load storage location" body="Snacky OS could not load this location for editing." />
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

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={`Edit Storage Location: ${location.name}`}
          subtitle="Update location metadata without editing stock balances directly."
          action={<SecondaryButton href={`/storage-locations/${location.id}`}>Back to detail</SecondaryButton>}
        />
        {query.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}
        <StorageLocationForm action={updateStorageLocation} location={location as StorageLocationRow} operators={operators ?? []} submitLabel="Save changes" />
      </FormPageLayout>
    </>
  );
}
