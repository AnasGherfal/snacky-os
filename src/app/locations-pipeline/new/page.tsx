import { LocationPipelineForm } from "@/components/LocationPipelineForm";
import { FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { createLocationPipelineLead } from "@/lib/location-pipeline-actions";
import { loadLocationPipelineContactUsers, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";

function notice(message: string, tone: "success" | "error") {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

export default async function NewLocationPipelineLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { profile } = await requireLocationPipelineAccess("/locations-pipeline/new");
  const contactUsers = await loadLocationPipelineContactUsers();
  const selectableContactUsers =
    profile.team_member_id && !contactUsers.some((user) => user.id === profile.team_member_id)
      ? [{ id: profile.team_member_id, full_name: profile.full_name, role: profile.role }, ...contactUsers]
      : contactUsers;
  const query = await searchParams;

  return (
    <FormPageLayout>
      <PageHeader
        title="New Location Lead / موقع محتمل جديد"
        subtitle="Capture an expansion opportunity before it becomes an active Snacky location."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations Pipeline", href: "/locations-pipeline" }, { label: "New lead" }]}
        action={<SecondaryButton href="/locations-pipeline">Back to pipeline</SecondaryButton>}
      />

      <div className="space-y-4">
        {query.success ? notice(String(query.success), "success") : null}
        {query.error ? notice(String(query.error), "error") : null}

        <LocationPipelineForm
          action={createLocationPipelineLead}
          contactUsers={selectableContactUsers}
          submitLabel="Create lead"
          cancelHref="/locations-pipeline"
          userId={profile.id}
          currentTeamMemberId={profile.team_member_id}
        />
      </div>
    </FormPageLayout>
  );
}
