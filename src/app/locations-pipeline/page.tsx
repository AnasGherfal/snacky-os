import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { convertLocationPipelineLead } from "@/lib/location-pipeline-actions";
import { LocationPipelineLeadRow, buildLocationPipelineAddressSummary, locationPipelinePlaceTypeLabel, locationPipelinePlaceTypes, locationPipelineStatusLabel, locationPipelineStatuses } from "@/lib/location-pipeline";
import { loadLocationPipelineContactUsers, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

type PipelineSearchParams = SearchParamsRecord & {
  q?: string;
  status?: string;
  place_type?: string;
  success?: string;
  error?: string;
};

function notice(message: string, tone: "success" | "error") {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

export default async function LocationsPipelinePage({ searchParams }: { searchParams: Promise<PipelineSearchParams> }) {
  const params = cleanSearchParams(await searchParams) as PipelineSearchParams;
  const { page, pageSize, from, to } = getPagination(params);
  const { supabase } = await requireLocationPipelineAccess("/locations-pipeline");

  const q = String(params.q ?? "").trim();
  const status = String(params.status ?? "").trim();
  const placeType = String(params.place_type ?? "").trim();

  let query = supabase
    .from("location_pipeline_leads")
    .select("*", { count: "exact" })
    .is("archived_at", null);

  if (q) {
    const pattern = supabaseLikePattern(q);
    query = query.or(
      [
        `place_name.ilike.${pattern}`,
        `area.ilike.${pattern}`,
        `contact_person_name.ilike.${pattern}`,
        `contact_phone.ilike.${pattern}`,
        `contact_whatsapp.ilike.${pattern}`,
      ].join(","),
    );
  }
  if (status) query = query.eq("status", status);
  if (placeType) query = query.eq("place_type", placeType);

  const [{ data, count, error }, contactUsers] = await Promise.all([
    query.order("updated_at", { ascending: false }).range(from, to),
    loadLocationPipelineContactUsers(),
  ]);

  if (error) {
    console.error("[locations-pipeline] Failed to load leads", error);
    return <ErrorState title="Could not load location leads" body="Snacky OS could not load potential location leads right now." action={<SecondaryButton href="/locations-pipeline">Retry</SecondaryButton>} />;
  }

  const rows = (data ?? []) as LocationPipelineLeadRow[];
  const contactNameById = new Map(contactUsers.map((user) => [user.id, user.full_name]));

  return (
    <>
      <PageHeader
        title="Locations Pipeline / مواقع محتملة"
        subtitle="Lightweight expansion CRM for candidate vending locations before they become active machine sites."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations Pipeline" }]}
        action={<PrimaryButton href="/locations-pipeline/new">Add location lead</PrimaryButton>}
      />

      <div className="space-y-4">
        {params.success ? notice(String(params.success), "success") : null}
        {params.error ? notice(String(params.error), "error") : null}

        <form action="/locations-pipeline" className="surface-card flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Search</span>
              <SearchInput defaultValue={q} placeholder="Place, area, contact, phone..." />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Status</span>
              <select name="status" defaultValue={status} className="field-input">
                <option value="">All statuses</option>
                {locationPipelineStatuses.map((item) => (
                  <option key={item} value={item}>
                    {locationPipelineStatusLabel(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Place type</span>
              <select name="place_type" defaultValue={placeType} className="field-input">
                <option value="">All place types</option>
                {locationPipelinePlaceTypes.map((item) => (
                  <option key={item} value={item}>
                    {locationPipelinePlaceTypeLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary">
              Apply filters
            </button>
            <SecondaryButton href="/locations-pipeline">Reset</SecondaryButton>
          </div>
        </form>

        {!rows.length ? (
          <EmptyState
            title="No potential locations found"
            body={q || status || placeType ? "Try changing the search or filters, or add a new location lead." : "Start tracking potential expansion sites before a machine is placed there."}
            action={<PrimaryButton href="/locations-pipeline/new">Add location lead</PrimaryButton>}
          />
        ) : (
          <>
            <MobileCardList>
              {rows.map((lead) => {
                const canConvert = lead.status === "accepted" && !lead.converted_location_id;
                const address = buildLocationPipelineAddressSummary(lead) ?? "No address yet";
                return (
                  <MobileRecordCard key={lead.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900">{lead.place_name}</div>
                        <div className="mt-1 text-sm text-slate-500">{locationPipelinePlaceTypeLabel(lead.place_type)}</div>
                      </div>
                      <StatusBadge status={lead.status} />
                    </div>
                    <div className="mt-4 grid gap-3">
                      <MobileField label="Area">{address}</MobileField>
                      <MobileField label="Contact">{lead.contact_person_name || contactNameById.get(lead.contacted_by_user_id ?? "") || "-"}</MobileField>
                      <MobileField label="Phone">{lead.contact_phone || lead.contact_whatsapp || "-"}</MobileField>
                      <MobileField label="Next follow-up">{lead.next_follow_up_date || "-"}</MobileField>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link href={`/locations-pipeline/${lead.id}`} className="btn-secondary">
                        Open
                      </Link>
                      {lead.converted_location_id ? (
                        <Link href={`/locations/${lead.converted_location_id}`} className="btn-secondary">
                          Active location
                        </Link>
                      ) : null}
                      {canConvert ? (
                        <form action={convertLocationPipelineLead}>
                          <input type="hidden" name="id" value={lead.id} />
                          <input type="hidden" name="return_to" value="/locations-pipeline" />
                          <button type="submit" className="btn-secondary">
                            Convert
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </MobileRecordCard>
                );
              })}
            </MobileCardList>

            <DataTable className="hidden md:block" headers={["Place", "Type", "Area", "Contact", "Status", "Next follow-up", "Actions"]}>
              {rows.map((lead) => {
                const canConvert = lead.status === "accepted" && !lead.converted_location_id;
                return (
                  <tr key={lead.id}>
                    <td className="font-medium text-slate-900">
                      <div>{lead.place_name}</div>
                      <div className="text-xs text-slate-500">{lead.contact_phone || lead.contact_whatsapp || "No phone"}</div>
                    </td>
                    <td>{locationPipelinePlaceTypeLabel(lead.place_type)}</td>
                    <td>{buildLocationPipelineAddressSummary(lead) ?? "-"}</td>
                    <td>{lead.contact_person_name || contactNameById.get(lead.contacted_by_user_id ?? "") || "-"}</td>
                    <td>
                      <StatusBadge status={lead.status} />
                    </td>
                    <td>{lead.next_follow_up_date || "-"}</td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <Link href={`/locations-pipeline/${lead.id}`} className="btn-secondary">
                          Open
                        </Link>
                        {lead.converted_location_id ? (
                          <Link href={`/locations/${lead.converted_location_id}`} className="btn-secondary">
                            Active location
                          </Link>
                        ) : null}
                        {canConvert ? (
                          <form action={convertLocationPipelineLead}>
                            <input type="hidden" name="id" value={lead.id} />
                            <input type="hidden" name="return_to" value="/locations-pipeline" />
                            <button type="submit" className="btn-secondary">
                              Convert
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DataTable>

            <PaginationControls basePath="/locations-pipeline" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="location leads" />
          </>
        )}
      </div>
    </>
  );
}
