import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { convertLocationPipelineLead } from "@/lib/location-pipeline-actions";
import {
  LocationPipelineLeadRow,
  buildLocationPipelineAddressSummary,
  locationPipelinePlaceTypeLabel,
  locationPipelinePlaceTypes,
  locationPipelinePriorityLabel,
  locationPipelinePriorities,
  locationPipelineSourceLabel,
  locationPipelineSources,
  locationPipelineStatusLabel,
  locationPipelineStatuses,
} from "@/lib/location-pipeline";
import { loadLocationPipelineContactUsers, locationPipelineLoadFailureBody, logLocationPipelineError, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

type PipelineSearchParams = SearchParamsRecord & {
  q?: string;
  status?: string;
  place_type?: string;
  source?: string;
  priority?: string;
  assigned_to?: string;
  success?: string;
  error?: string;
};

function notice(message: string, tone: "success" | "error") {
  const styles = tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

function MetricCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="surface-card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-bold text-slate-950">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

export default async function LocationsPipelinePage({ searchParams }: { searchParams: Promise<PipelineSearchParams> }) {
  const params = cleanSearchParams(await searchParams) as PipelineSearchParams;
  const { page, pageSize, from, to } = getPagination(params);
  const { profile, supabase } = await requireLocationPipelineAccess("/locations-pipeline");

  const q = String(params.q ?? "").trim();
  const status = String(params.status ?? "").trim();
  const placeType = String(params.place_type ?? "").trim();
  const source = String(params.source ?? "").trim();
  const priority = String(params.priority ?? "").trim();
  const assignedTo = String(params.assigned_to ?? "").trim();

  let query = supabase.from("location_pipeline_leads").select("*", { count: "exact" }).is("archived_at", null);
  if (q) {
    const pattern = supabaseLikePattern(q);
    query = query.or([
      `place_name.ilike.${pattern}`,
      `area.ilike.${pattern}`,
      `contact_person_name.ilike.${pattern}`,
      `contact_phone.ilike.${pattern}`,
      `contact_whatsapp.ilike.${pattern}`,
      `next_action.ilike.${pattern}`,
    ].join(","));
  }
  if (status) query = query.eq("status", status);
  if (placeType) query = query.eq("place_type", placeType);
  if (source) query = query.eq("source", source);
  if (priority) query = query.eq("priority", priority);
  if (assignedTo === "unassigned") query = query.is("assigned_to_user_id", null);
  else if (assignedTo) query = query.eq("assigned_to_user_id", assignedTo);

  const today = new Date().toISOString().slice(0, 10);
  const [{ data, count, error }, contactUsers, totalResult, dueResult, visitResult, proposalResult, wonResult] = await Promise.all([
    query.order("next_action_date", { ascending: true, nullsFirst: false }).order("updated_at", { ascending: false }).range(from, to),
    loadLocationPipelineContactUsers(),
    supabase.from("location_pipeline_leads").select("id", { count: "exact", head: true }).is("archived_at", null).not("status", "in", '(rejected,machine_placed)'),
    supabase.from("location_pipeline_leads").select("id", { count: "exact", head: true }).is("archived_at", null).lte("next_action_date", today).not("status", "in", '(rejected,machine_placed)'),
    supabase.from("location_pipeline_leads").select("id", { count: "exact", head: true }).is("archived_at", null).in("status", ["visit_scheduled", "visited"]),
    supabase.from("location_pipeline_leads").select("id", { count: "exact", head: true }).is("archived_at", null).in("status", ["offer_sent", "negotiating", "trial_contract"]),
    supabase.from("location_pipeline_leads").select("id", { count: "exact", head: true }).is("archived_at", null).in("status", ["accepted", "machine_placed"]),
  ]);

  if (error) {
    logLocationPipelineError({
      action: "Failed to load CRM leads",
      table: "location_pipeline_leads",
      profile,
      error,
      extra: { q: q || null, status: status || null, place_type: placeType || null, source: source || null, priority: priority || null, assigned_to: assignedTo || null, page, page_size: pageSize },
    });
    return <ErrorState title="Could not load Snacky CRM" body={locationPipelineLoadFailureBody(error)} action={<SecondaryButton href="/locations-pipeline">Retry</SecondaryButton>} />;
  }

  const rows = (data ?? []) as LocationPipelineLeadRow[];
  const userNameById = new Map(contactUsers.map((user) => [user.id, user.full_name]));
  const hasFilters = Boolean(q || status || placeType || source || priority || assignedTo);

  return (
    <>
      <PageHeader
        title="Snacky CRM / مواقع محتملة"
        subtitle="One shared place for inbound business inquiries, field visits, follow-ups, proposals and conversion into active Snacky locations."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Snacky CRM" }]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/issues">Customer / machine issues</SecondaryButton>
            <PrimaryButton href="/locations-pipeline/new">Add lead</PrimaryButton>
          </div>
        }
      />

      <div className="space-y-4">
        {params.success ? notice(String(params.success), "success") : null}
        {params.error ? notice(String(params.error), "error") : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="Active leads" value={totalResult.count ?? 0} hint="Not lost or already placed" />
          <MetricCard label="Follow-up due" value={dueResult.count ?? 0} hint="Next action today or overdue" />
          <MetricCard label="Visits" value={visitResult.count ?? 0} hint="Scheduled or recently visited" />
          <MetricCard label="Proposal / negotiation" value={proposalResult.count ?? 0} hint="Commercial discussion active" />
          <MetricCard label="Won" value={wonResult.count ?? 0} hint="Accepted or converted" />
        </div>

        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span className="font-semibold">Simple rule:</span> business asking for a Snacky machine → add it here. A person reporting a machine/payment/product problem → use Customer / machine issues.
        </div>

        <form action="/locations-pipeline" className="surface-card space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Search</span>
              <SearchInput defaultValue={q} placeholder="Place, contact, phone, next action..." />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Status</span>
              <select name="status" defaultValue={status} className="field-input">
                <option value="">All statuses</option>
                {locationPipelineStatuses.map((item) => <option key={item} value={item}>{locationPipelineStatusLabel(item)}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Place type</span>
              <select name="place_type" defaultValue={placeType} className="field-input">
                <option value="">All types</option>
                {locationPipelinePlaceTypes.map((item) => <option key={item} value={item}>{locationPipelinePlaceTypeLabel(item)}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Source</span>
              <select name="source" defaultValue={source} className="field-input">
                <option value="">All sources</option>
                {locationPipelineSources.map((item) => <option key={item} value={item}>{locationPipelineSourceLabel(item)}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Priority</span>
              <select name="priority" defaultValue={priority} className="field-input">
                <option value="">All priorities</option>
                {locationPipelinePriorities.map((item) => <option key={item} value={item}>{locationPipelinePriorityLabel(item)}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Assigned to</span>
              <select name="assigned_to" defaultValue={assignedTo} className="field-input">
                <option value="">Everyone</option>
                <option value="unassigned">Unassigned</option>
                {contactUsers.map((user) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary">Apply filters</button>
            <SecondaryButton href="/locations-pipeline">Reset</SecondaryButton>
          </div>
        </form>

        {!rows.length ? (
          <EmptyState
            title={hasFilters ? "No leads matched your filters" : "No CRM leads yet"}
            body={hasFilters ? "Change the filters or add the lead directly." : "Add inbound inquiries and places worth visiting so every follow-up has an owner and next action."}
            action={<PrimaryButton href="/locations-pipeline/new">Add lead</PrimaryButton>}
          />
        ) : (
          <>
            <MobileCardList>
              {rows.map((lead) => {
                const canConvert = lead.status === "accepted" && !lead.converted_location_id && !lead.is_archived && !lead.archived_at;
                const address = buildLocationPipelineAddressSummary(lead) ?? "No address yet";
                const assignee = userNameById.get(lead.assigned_to_user_id ?? "") ?? "Unassigned";
                const isDue = Boolean(lead.next_action_date && lead.next_action_date <= today && !["rejected", "machine_placed"].includes(String(lead.status)));
                return (
                  <MobileRecordCard key={lead.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900">{lead.place_name}</div>
                        <div className="mt-1 text-sm text-slate-500">{locationPipelinePlaceTypeLabel(lead.place_type)} · {locationPipelineSourceLabel(lead.source)}</div>
                      </div>
                      <StatusBadge status={lead.status} />
                    </div>
                    <div className="mt-4 grid gap-3">
                      <MobileField label="Area">{address}</MobileField>
                      <MobileField label="Contact">{lead.contact_person_name || "-"}</MobileField>
                      <MobileField label="Phone">{lead.contact_phone || lead.contact_whatsapp || "-"}</MobileField>
                      <MobileField label="Assigned">{assignee}</MobileField>
                      <MobileField label="Next action"><span className={isDue ? "font-semibold text-rose-700" : ""}>{lead.next_action || "No next action"}{lead.next_action_date ? ` · ${lead.next_action_date}` : ""}</span></MobileField>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link href={`/locations-pipeline/${lead.id}`} className="btn-secondary">Open</Link>
                      {lead.converted_location_id ? <Link href={`/locations/${lead.converted_location_id}`} className="btn-secondary">Active location</Link> : null}
                      {canConvert ? (
                        <form action={convertLocationPipelineLead}>
                          <input type="hidden" name="id" value={lead.id} />
                          <input type="hidden" name="return_to" value="/locations-pipeline" />
                          <button type="submit" className="btn-secondary">Convert</button>
                        </form>
                      ) : null}
                    </div>
                  </MobileRecordCard>
                );
              })}
            </MobileCardList>

            <DataTable className="hidden md:block" headers={["Place", "Type", "Contact", "Status", "Priority", "Assigned", "Next action", "Actions"]}>
              {rows.map((lead) => {
                const canConvert = lead.status === "accepted" && !lead.converted_location_id && !lead.is_archived && !lead.archived_at;
                const assignee = userNameById.get(lead.assigned_to_user_id ?? "") ?? "Unassigned";
                const isDue = Boolean(lead.next_action_date && lead.next_action_date <= today && !["rejected", "machine_placed"].includes(String(lead.status)));
                return (
                  <tr key={lead.id}>
                    <td className="font-medium text-slate-900">
                      <div>{lead.place_name}</div>
                      <div className="text-xs text-slate-500">{buildLocationPipelineAddressSummary(lead) ?? "No address"}</div>
                    </td>
                    <td>{locationPipelinePlaceTypeLabel(lead.place_type)}<div className="text-xs text-slate-500">{locationPipelineSourceLabel(lead.source)}</div></td>
                    <td>{lead.contact_person_name || "-"}<div className="text-xs text-slate-500">{lead.contact_phone || lead.contact_whatsapp || "No phone"}</div></td>
                    <td><StatusBadge status={lead.status} /></td>
                    <td>{locationPipelinePriorityLabel(lead.priority)}</td>
                    <td>{assignee}</td>
                    <td className={isDue ? "font-semibold text-rose-700" : ""}>{lead.next_action || "-"}<div className="text-xs">{lead.next_action_date || ""}</div></td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/locations-pipeline/${lead.id}`} className="btn-secondary">Open</Link>
                        {lead.converted_location_id ? <Link href={`/locations/${lead.converted_location_id}`} className="btn-secondary">Active location</Link> : null}
                        {canConvert ? (
                          <form action={convertLocationPipelineLead}>
                            <input type="hidden" name="id" value={lead.id} />
                            <input type="hidden" name="return_to" value="/locations-pipeline" />
                            <button type="submit" className="btn-secondary">Convert</button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DataTable>

            <PaginationControls basePath="/locations-pipeline" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="CRM leads" />
          </>
        )}
      </div>
    </>
  );
}
