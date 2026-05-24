import { redirect } from "next/navigation";
import { CashCollectionForm } from "@/components/CashCollectionForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { createManualCashCollection } from "@/lib/cash-actions";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function NewCashCollectionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }

  const { error = "" } = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Cash collection unavailable" body="Supabase is not configured, so Snacky OS cannot create cash collection records." />
      </>
    );
  }
  const [{ data: machines, error: machinesError }, { data: routes, error: routesError }, { data: operators, error: operatorsError }] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, status").order("name"),
    supabase.from("routes").select("id, route_date, status").order("route_date", { ascending: false }).limit(200),
    supabase.from("team_members").select("id, full_name, role, active").eq("active", true).order("full_name"),
  ]);
  const loadError = machinesError ?? routesError ?? operatorsError;
  if (loadError) {
    console.error("[cash] Failed to load new cash collection form", loadError);
    return (
      <>
        <ErrorState title="Could not load cash form" body="Snacky OS could not load machines, routes, or operators for cash entry." action={<SecondaryButton href="/cash-collections">Back</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New Cash Collection"
          subtitle="Manual counted cash entry that posts actual money-in to finance."
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Cash Collections", href: "/cash-collections" },
            { label: "New collection" },
          ]}
          action={<SecondaryButton href="/cash-collections">Back</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <CashCollectionForm
          action={createManualCashCollection}
          machines={(machines ?? []).map((machine: any) => ({ id: machine.id, label: `${machine.name}${machine.machine_code ? ` (${machine.machine_code})` : ""}` }))}
          routes={(routes ?? []).map((route: any) => ({ id: route.id, label: `${route.route_date} - ${route.status}` }))}
          operators={(operators ?? []).map((operator: any) => ({ id: operator.id, label: `${operator.full_name} - ${operator.role}` }))}
          submitLabel="Save and post finance"
          countedRequired
        />
      </FormPageLayout>
    </>
  );
}
