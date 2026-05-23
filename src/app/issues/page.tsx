import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function IssuesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { type?: string }> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const type = String(params.type ?? "");
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Issues unavailable" body="Supabase is not configured, so Snacky OS cannot load issue records." />
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
        <ErrorState title="Could not load issues" body="Snacky OS could not load machine issue records from Supabase." action={<SecondaryButton href="/issues">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Issues" subtitle="Track machine incidents, priorities, and SLA execution." />
      {!issues?.length ? (
        <EmptyState title={type ? "No matching issues" : "No issues yet"} body="Operator-reported machine problems will appear here." />
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
