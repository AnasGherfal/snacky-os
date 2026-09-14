import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export default async function IssuesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { type?: string }> }) {
  await requireCurrentProfileForPath("/issues");
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const type = String(params.type ?? "");
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Customer issues unavailable" body="Supabase is not configured, so Snacky OS cannot load customer and machine issue records." />
      </>
    );
  }

  let query = supabase
    .from("issues")
    .select("id, issue_type, priority, status, description, machines(name)", { count: "exact" })
    .order("created_at", { ascending: false });
  if (type) query = query.ilike("issue_type", supabaseLikePattern(type));
  const { data: issues, count, error } = await query.range(from, to);

  if (error) {
    console.error("[issues] Failed to load issues", error);
    return (
      <>
        <ErrorState title="Could not load customer issues" body="Snacky OS could not load issue records from Supabase." action={<SecondaryButton href="/issues">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Customer Issues"
        subtitle="Track customer reports and machine incidents separately from business-development leads and visits."
        breadcrumbs={[{ label: "Snacky CRM", href: "/locations-pipeline" }, { label: "Customer Issues" }]}
      />
      {!issues?.length ? (
        <EmptyState title={type ? "No matching issues" : "No customer issues yet"} body="Customer and operator-reported machine problems will appear here." />
      ) : (
        <>
          <DataTable headers={["Machine", "Type", "Priority", "Status", "Description"]}>
            {issues.map((issue: any) => (
              <tr key={issue.id}>
                <td className="font-medium">{issue.machines?.name ?? "-"}</td>
                <td>{issue.issue_type}</td>
                <td><StatusBadge status={issue.priority} /></td>
                <td><StatusBadge status={issue.status} /></td>
                <td>{issue.description}</td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/issues" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="issues" />
        </>
      )}
    </>
  );
}
