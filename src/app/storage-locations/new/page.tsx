import { redirect } from "next/navigation";
import { StorageLocationForm } from "@/components/StorageLocationForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { createStorageLocation } from "@/lib/storage-location-actions";

export const dynamic = "force-dynamic";

export default async function NewStorageLocationPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile.role)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Storage locations unavailable" body="Supabase is not configured, so Snacky OS cannot create storage locations." />
      </>
    );
  }

  const { data: operators } = await supabase
    .from("team_members")
    .select("id, full_name, email, role")
    .in("role", ["operator", "warehouse", "supervisor"])
    .eq("active", true)
    .order("full_name");

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New Storage Location"
          subtitle="Create a warehouse, operator bag, vehicle, or internal stock location for inventory movements."
          action={<SecondaryButton href="/storage-locations">Back to locations</SecondaryButton>}
        />
        {params.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
        <StorageLocationForm action={createStorageLocation} operators={operators ?? []} submitLabel="Create location" />
      </FormPageLayout>
    </>
  );
}
