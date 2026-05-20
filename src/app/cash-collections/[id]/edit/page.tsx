import { notFound, redirect } from "next/navigation";
import { CashCollectionForm } from "@/components/CashCollectionForm";
import { EmptyState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { updateCashCollection } from "@/lib/cash-actions";
import { getCurrentProfile } from "@/lib/auth";
import { canViewFinancials } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function EditCashCollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canViewFinancials({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }

  const { id } = await params;
  const { error = "" } = await searchParams;
  const supabase = getSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: collection }, { data: machines }, { data: routes }, { data: operators }] = await Promise.all([
    supabase.from("cash_collections").select("*").eq("id", id).maybeSingle(),
    supabase.from("machines").select("id, name, machine_code, status").order("name"),
    supabase.from("routes").select("id, route_date, status").order("route_date", { ascending: false }).limit(200),
    supabase.from("team_members").select("id, full_name, role, active").eq("active", true).order("full_name"),
  ]);

  if (!collection) notFound();
  if ((collection as any).review_status === "voided") {
    return (
      <>
        <EmptyState title="Voided cash collection" body="Voided cash collections cannot be edited. Create a new collection if money needs to be recorded." />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Edit Cash Collection"
          subtitle="Update collection details and counted amount."
          breadcrumbs={[
            { label: "Finance", href: "/finance" },
            { label: "Cash Collections", href: "/cash-collections" },
            { label: id.slice(0, 8), href: `/cash-collections/${id}` },
            { label: "Edit collection" },
          ]}
          action={<SecondaryButton href={`/cash-collections/${id}`}>Back to collection</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <CashCollectionForm
          action={updateCashCollection}
          machines={(machines ?? []).map((machine: any) => ({ id: machine.id, label: `${machine.name}${machine.machine_code ? ` (${machine.machine_code})` : ""}` }))}
          routes={(routes ?? []).map((route: any) => ({ id: route.id, label: `${route.route_date} - ${route.status}` }))}
          operators={(operators ?? []).map((operator: any) => ({ id: operator.id, label: `${operator.full_name} - ${operator.role}` }))}
          initial={{
            id,
            machineId: (collection as any).machine_id,
            routeId: (collection as any).route_id,
            operatorId: (collection as any).operator_id,
            collectedAt: (collection as any).collected_at,
            expectedCash: (collection as any).vms_expected_cash === null ? null : Number((collection as any).vms_expected_cash),
            countedAmount: (collection as any).actual_cash_collected === null ? null : Number((collection as any).actual_cash_collected),
            cashBagId: (collection as any).cash_bag_id,
            notes: (collection as any).notes,
          }}
          submitLabel="Save collection"
        />
      </FormPageLayout>
    </>
  );
}
