import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { TeamMemberForm } from "@/components/TeamMemberForm";
import { FormPageLayout, PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { createTeamMember } from "@/lib/team-actions";

export default async function NewTeamMemberPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const { error } = await searchParams;

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Add team member" subtitle="Create the operational team record and assign the correct Snacky OS role." />
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
            {error}
          </div>
        ) : null}
        <TeamMemberForm action={createTeamMember} submitLabel="Create member" />
      </FormPageLayout>
    </AppShell>
  );
}
