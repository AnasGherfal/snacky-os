import { StorageLocationForm } from "@/components/StorageLocationForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { createStorageLocation } from "@/lib/storage-location-actions";
import { getServerI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewStorageLocationPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title={locale === "ar" ? "مواقع التخزين غير متاحة" : "Storage locations unavailable"} body={locale === "ar" ? "لم يتم إعداد Supabase، لذلك لا يمكن لـ Snacky OS إنشاء مواقع التخزين." : "Supabase is not configured, so Snacky OS cannot create storage locations."} />
      </>
    );
  }

  const { data: operators } = await supabase
    .from("team_members")
    .select("id, full_name, email, role, roles")
    .or("role.in.(operator,warehouse,supervisor),roles.ov.{operator,warehouse,supervisor}")
    .eq("active", true)
    .order("full_name");

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={locale === "ar" ? "موقع تخزين جديد" : "New Storage Location"}
          subtitle={locale === "ar" ? "أنشئ مخزنًا أو حقيبة مشغل أو مركبة أو موقع مخزون داخلي لحركات المخزون." : "Create a warehouse, operator bag, vehicle, or internal stock location for inventory movements."}
          action={<SecondaryButton href="/storage-locations">{locale === "ar" ? "العودة إلى المواقع" : "Back to locations"}</SecondaryButton>}
        />
        {params.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
        <StorageLocationForm action={createStorageLocation} operators={operators ?? []} submitLabel={locale === "ar" ? "إنشاء الموقع" : "Create location"} />
      </FormPageLayout>
    </>
  );
}
