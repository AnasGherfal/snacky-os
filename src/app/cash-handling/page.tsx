import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canRecordCashRemoval, hasAnyRole, isOperatorRole } from "@/lib/authz";
import { cashHandlingRoles, cashUuid } from "@/lib/cash-handover";
import { CashHandlingWorkspace } from "@/components/CashHandlingWorkspace";
import { CashRemovalForm } from "@/components/CashRemovalForm";
import { ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { createCashRemoval } from "@/lib/cash-actions";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

export const dynamic = "force-dynamic";

export default async function CashHandlingPage({
  searchParams,
}: {
  searchParams: Promise<{ collect?: string; error?: string; success?: string; machine_id?: string; id?: string; submission_id?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, cashHandlingRoles)) {
    redirect("/unauthorized");
  }

  const params = await searchParams;
  const context = {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  } as const;
  const canRemove = canRecordCashRemoval(context);
  const showCollectionForm = canRemove && (params.collect === "1" || Boolean(params.error));

  if (params.collect === "1" && !canRemove) redirect("/cash-handling");

  if (showCollectionForm) {
    const supabase = await getAuthenticatedSupabaseServerClient();
    if (!supabase) {
      return <ErrorState title="Cash collection unavailable" body="Snacky OS could not load the machine list." />;
    }

    const { data: machines, error } = await supabase
      .from("machines")
      .select("id, name, machine_code, location:locations(id, name), status")
      .neq("status", "inactive")
      .order("name");

    if (error) {
      console.error("[cash] Failed to load unified cash-removal form", error);
      return (
        <ErrorState
          title="Could not load cash collection"
          body="Snacky OS could not load the available machines."
          action={<SecondaryButton href="/cash-handling?collect=1">Retry</SecondaryButton>}
        />
      );
    }

    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <PageHeader
          title="Cash"
          subtitle="Record cash removed from machines, then continue the same custody and handover process here."
          action={<SecondaryButton href="/cash-handling">Back to cash</SecondaryButton>}
        />
        {params.error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800">
            {params.error}
          </div>
        ) : null}
        <CashRemovalForm
          action={createCashRemoval}
          machines={(machines ?? []).map((machine) => ({
            id: machine.id,
            label: formatMachineDisplayName(machine, { includeArea: true }),
          }))}
          selectedMachineId={params.machine_id}
          clientSubmissionId={params.submission_id && cashUuid.test(params.submission_id) ? params.submission_id : crypto.randomUUID()}
          cancelHref="/cash-handling"
          requiresAmounts={!isOperatorRole(context)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {params.success ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
          {params.success}
        </div>
      ) : null}
      <CashHandlingWorkspace userId={profile.id} />
    </div>
  );
}
