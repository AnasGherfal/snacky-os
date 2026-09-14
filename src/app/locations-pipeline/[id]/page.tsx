import Link from "next/link";
import { LocationPipelineForm } from "@/components/LocationPipelineForm";
import { EmptyState, ErrorState, FormField, FormPageLayout, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { addLocationPipelineActivity, convertLocationPipelineLead, updateLocationPipelineLead } from "@/lib/location-pipeline-actions";
import {
  LocationPipelineActivityRow,
  LocationPipelineLeadRow,
  buildLocationPipelineAddressSummary,
  locationPipelineActivityTypeLabel,
  locationPipelineActivityTypes,
  locationPipelinePlaceTypeLabel,
  locationPipelinePriorityLabel,
  locationPipelineSourceLabel,
  locationPipelineStatusLabel,
  locationPipelineStatuses,
} from "@/lib/location-pipeline";
import { loadLocationPipelineContactUsers, locationPipelineLoadFailureBody, logLocationPipelineError, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";

function notice(message: string, tone: "success" | "error") {
  const styles = tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
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
  const [query, leadResult, activityResult, contactUsers] = await Promise.all([
    searchParams,
    supabase.from("location_pipeline_leads").select("*").eq("id", id).maybeSingle(),
    supabase.from("location_pipeline_activities").select("*").eq("lead_id", id).order("occurred_at", { ascending: false }).limit(100),
    loadLocationPipelineContactUsers(),
  ]);

  if (leadResult.error) {
    logLocationPipelineError({ action: "Failed to load lead", table: "location_pipeline_leads", profile, error: leadResult.error, extra: { lead_id: id } });
    return <ErrorState title="Could not load location lead" body={locationPipelineLoadFailureBody(leadResult.error, "this location lead")} action={<SecondaryButton href="/locations-pipeline">Back to CRM</SecondaryButton>} />;
  }

  const lead = leadResult.data;
  if (!lead) {
    return <EmptyState title="Location lead not found" body="This lead may have been removed, archived, or is no longer visible to your role." action={<SecondaryButton href="/locations-pipeline">Back to CRM</SecondaryButton>} />;
  }

  if (activityResult.error) {
    logLocationPipelineError({ action: "Failed to load CRM activity", table: "location_pipeline_activities", profile, error: activityResult.error, extra: { lead_id: id } });
  }

  const typedLead = lead as LocationPipelineLeadRow;
  const activities = (activityResult.data ?? []) as LocationPipelineActivityRow[];
  const selectableContactUsers = profile.team_member_id && !contactUsers.some((user) => user.id === profile.team_member_id)
    ? [{ id: profile.team_member_id, full_name: profile.full_name, role: profile.role }, ...contactUsers]
    : contactUsers;
  const userNameById = new Map(selectableContactUsers.map((user) => [user.id, user.full_name]));
  const canConvert = typedLead.status === "accepted" && !typedLead.converted_location_id && !typedLead.archived_at && !typedLead.is_archived;
  const assigneeName = userNameById.get(typedLead.assigned_to_user_id ?? "") ?? "Unassigned";

  return (
    <FormPageLayout>
      <PageHeader
        title={typedLead.place_name}
        subtitle="Business lead, visit history, follow-ups and conversion into an active Snacky location."
        breadcrumbs={[{ label: "Snacky CRM", href: "/locations-pipeline" }, { label: typedLead.place_name }]}
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            {typedLead.converted_location_id ? <SecondaryButton href={`/locations/${typedLead.converted_location_id}`}>Open active location</SecondaryButton> : null}
            {canConvert ? (
              <form action={convertLocationPipelineLead}>
                <input type="hidden" name="id" value={typedLead.id} />
                <input type="hidden" name="return_to" value={`/locations-pipeline/${typedLead.id}`} />
                <button type="submit" className="btn-primary">Convert to active location</button>
              </form>
            ) : null}
            <SecondaryButton href="/locations-pipeline">Back to CRM</SecondaryButton>
          </div>
        }
      />

      <div className="space-y-5">
        {query.success ? notice(String(query.success), "success") : null}
        {query.error ? notice(String(query.error), "error") : null}

        <SectionCard>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
              <div className="mt-2"><StatusBadge status={typedLead.status} /></div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Type</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{locationPipelinePlaceTypeLabel(typedLead.place_type)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{locationPipelineSourceLabel(typedLead.source)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Priority</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{locationPipelinePriorityLabel(typedLead.priority)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assigned</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{assigneeName}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Area</div>
              <div className="mt-2 text-sm font-medium text-slate-900">{buildLocationPipelineAddressSummary(typedLead) ?? "-"}</div>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next action</div>
            <div className="mt-1 font-semibold text-slate-900">{typedLead.next_action || "No next action set"}</div>
            <div className="mt-1 text-xs text-slate-500">{typedLead.next_action_date || "No date"}</div>
          </div>
        </SectionCard>

        <SectionCard>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Activity / follow-up history</h2>
              <p className="mt-1 text-sm text-slate-500">Calls, WhatsApp messages, field visits, meetings and proposals stay attached to this place.</p>
            </div>
            {typedLead.imported_source ? <div className="text-xs text-slate-500">Imported: {typedLead.imported_source} · {typedLead.imported_category || "Archive"}</div> : null}
          </div>

          <form action={addLocationPipelineActivity} className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <input type="hidden" name="lead_id" value={typedLead.id} />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <FormField label="Activity">
                <select name="activity_type" defaultValue="call" className="field-input">
                  {locationPipelineActivityTypes.map((type) => <option key={type} value={type}>{locationPipelineActivityTypeLabel(type)}</option>)}
                </select>
              </FormField>
              <FormField label="When" hint="Leave empty for now.">
                <input type="datetime-local" name="occurred_at" className="field-input" />
              </FormField>
              <FormField label="Status after this activity">
                <select name="status_after" defaultValue="" className="field-input">
                  <option value="">Keep current status</option>
                  {locationPipelineStatuses.filter((status) => status !== "machine_placed" || Boolean(typedLead.converted_location_id)).map((status) => <option key={status} value={status}>{locationPipelineStatusLabel(status)}</option>)}
                </select>
              </FormField>
              <div className="md:col-span-2 xl:col-span-3">
                <FormField label="What happened?" required>
                  <textarea required name="summary" rows={3} className="field-input" placeholder="Spoke with the manager. Interested in one machine near reception; asked us to visit on Tuesday..." />
                </FormField>
              </div>
              <FormField label="Outcome"><input name="outcome" className="field-input" placeholder="Interested / no answer / proposal requested..." /></FormField>
              <FormField label="Next action"><input name="activity_next_action" className="field-input" placeholder="Visit / Call again / Send proposal" /></FormField>
              <FormField label="Next action date"><input type="date" name="activity_next_action_date" className="field-input" /></FormField>
            </div>
            <div className="mt-4"><PrimaryButton>Save activity</PrimaryButton></div>
          </form>

          <div className="mt-5 space-y-3">
            {activityResult.error ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Activity history could not be loaded. Lead details are still available.</div>
            ) : !activities.length ? (
              <div className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-500">No activity recorded yet. Add the first call, WhatsApp message or visit above.</div>
            ) : activities.map((activity) => (
              <div key={activity.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">{locationPipelineActivityTypeLabel(activity.activity_type)}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatDateTime(activity.occurred_at)} · {userNameById.get(activity.created_by_user_id ?? "") ?? "Snacky"}</div>
                  </div>
                  {activity.outcome ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{activity.outcome}</span> : null}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">{activity.summary}</p>
                {activity.next_action || activity.next_action_date ? (
                  <div className="mt-3 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900">
                    <span className="font-semibold">Next:</span> {activity.next_action || "Follow up"}{activity.next_action_date ? ` · ${activity.next_action_date}` : ""}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>

        <LocationPipelineForm
          action={updateLocationPipelineLead}
          contactUsers={selectableContactUsers}
          lead={typedLead}
          submitLabel="Save lead details"
          cancelHref="/locations-pipeline"
          userId={profile.id}
          currentTeamMemberId={profile.team_member_id}
        />
      </div>
    </FormPageLayout>
  );
}
