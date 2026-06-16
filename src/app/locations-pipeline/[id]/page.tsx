import Link from "next/link";
import { LocationPipelineForm } from "@/components/LocationPipelineForm";
import { EmptyState, ErrorState, FormPageLayout, PageHeader, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { convertLocationPipelineLead, updateLocationPipelineLead } from "@/lib/location-pipeline-actions";
import { LocationPipelineLeadRow, buildLocationPipelineAddressSummary, locationPipelinePlaceTypeLabel } from "@/lib/location-pipeline";
import { loadLocationPipelineContactUsers, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";

function notice(message: string, tone: "success" | "error") {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

export default async function LocationPipelineLeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const { profile, supabase } = await requireLocationPipelineAccess(`/locations-pipeline/${id}`);
  const [query, leadResult, contactUsers] = await Promise.all([
    searchParams,
    supabase.from("location_pipeline_leads").select("*").eq("id", id).maybeSingle(),
    loadLocationPipelineContactUsers(),
  ]);

  if (leadResult.error) {
    console.error("[locations-pipeline] Failed to load lead", { id, error: leadResult.error });
    return <ErrorState title="Could not load location lead" body="Snacky OS could not load this potential location right now." action={<SecondaryButton href="/locations-pipeline">Back to pipeline</SecondaryButton>} />;
  }

  const lead = leadResult.data;
  if (!lead) {
    return (
      <EmptyState
        title="Location lead not found"
        body="This location lead may have been removed, archived, or is no longer visible to your role."
        action={<SecondaryButton href="/locations-pipeline">Back to pipeline</SecondaryButton>}
      />
    );
  }

  const typedLead = lead as LocationPipelineLeadRow;
  const selectableContactUsers =
    profile.team_member_id && !contactUsers.some((user) => user.id === profile.team_member_id)
      ? [{ id: profile.team_member_id, full_name: profile.full_name, role: profile.role }, ...contactUsers]
      : contactUsers;
  const canConvert = typedLead.status === "accepted" && !typedLead.converted_location_id && !typedLead.archived_at;

  return (
    <FormPageLayout>
      <PageHeader
        title={typedLead.place_name}
        subtitle="Potential location profile, follow-up status, and conversion into an active Snacky location."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations Pipeline", href: "/locations-pipeline" }, { label: typedLead.place_name }]}
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            {typedLead.converted_location_id ? (
              <SecondaryButton href={`/locations/${typedLead.converted_location_id}`}>Open active location</SecondaryButton>
            ) : null}
            {canConvert ? (
              <form action={convertLocationPipelineLead}>
                <input type="hidden" name="id" value={typedLead.id} />
                <input type="hidden" name="return_to" value={`/locations-pipeline/${typedLead.id}`} />
                <button type="submit" className="btn-primary">
                  Convert to active location
                </button>
              </form>
            ) : null}
            <SecondaryButton href="/locations-pipeline">Back to pipeline</SecondaryButton>
          </div>
        }
      />

      <div className="space-y-4">
        {query.success ? notice(String(query.success), "success") : null}
        {query.error ? notice(String(query.error), "error") : null}

        <SectionCard>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
              <div className="mt-2">
                <StatusBadge status={typedLead.status} />
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Place type</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{locationPipelinePlaceTypeLabel(typedLead.place_type)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Area</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{buildLocationPipelineAddressSummary(typedLead) ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active location</div>
              <div className="mt-2 text-sm font-medium text-slate-900">
                {typedLead.converted_location_id ? (
                  <Link href={`/locations/${typedLead.converted_location_id}`} className="text-[var(--snacky-primary)] hover:underline">
                    {typedLead.converted_location_id.slice(0, 8)}
                  </Link>
                ) : (
                  "Not converted yet"
                )}
              </div>
            </div>
          </div>
        </SectionCard>

        <LocationPipelineForm
          action={updateLocationPipelineLead}
          contactUsers={selectableContactUsers}
          lead={typedLead}
          submitLabel="Save changes"
          cancelHref="/locations-pipeline"
          userId={profile.id}
          currentTeamMemberId={profile.team_member_id}
        />
      </div>
    </FormPageLayout>
  );
}
