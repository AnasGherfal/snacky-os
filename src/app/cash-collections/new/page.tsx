import { redirect } from "next/navigation";
import { CashRemovalForm } from "@/components/CashRemovalForm";
import { ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { createCashRemoval } from "@/lib/cash-actions";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canRecordCashRemoval, canViewFinancials } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function NewCashCollectionPage({ searchParams }: { searchParams: Promise<{ error?: string; machine_id?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canRecordCashRemoval({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status })) {
    redirect("/unauthorized");
  }
  const profileContext = { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status };
  const backHref = canViewFinancials(profileContext) ? "/cash-collections" : "/operator/routes";

  const { error = "", machine_id: selectedMachineId } = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Cash collection unavailable" body="Supabase is not configured, so Snacky OS cannot create cash collection records." />
      </>
    );
  }
  const { data: machines, error: loadError } = await supabase
    .from("machines")
    .select("id, name, machine_code, location:locations(id, name), status")
    .neq("status", "inactive")
    .order("name");
  if (loadError) {
    console.error("[cash] Failed to load new cash collection form", loadError);
    return (
      <>
        <ErrorState title="Could not load cash-removal form" body="Snacky OS could not load the available machines." action={<SecondaryButton href="/cash-collections/new">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Record Cash Removal"
          subtitle="Use this whenever cash leaves one or more machines. It is independent from route completion."
          breadcrumbs={[
            { label: canViewFinancials(profileContext) ? "Cash Collections" : "Operations", href: backHref },
            { label: "Remove cash" },
          ]}
          action={<SecondaryButton href={backHref}>Back</SecondaryButton>}
        />
        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
        <CashRemovalForm
          action={createCashRemoval}
          machines={(machines ?? []).map((machine: any) => ({ id: machine.id, label: formatMachineDisplayName(machine, { includeArea: true }) }))}
          selectedMachineId={selectedMachineId}
          clientSubmissionId={crypto.randomUUID()}
          cancelHref={backHref}
        />
      </FormPageLayout>
    </>
  );
}
