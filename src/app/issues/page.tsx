import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export default async function IssuesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { type?: string }> }) {
  const profile = await requireCurrentProfileForPath("/issues");
  // The global support list contains customer contact details. Operators use
  // their own reporting/history screen, not this service-role global query.
  if (!hasPermission(profile, "issues.view")) redirect("/operator/issues");
  const canCreate = hasPermission(profile, "issues.create");
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const type = String(params.type ?? "");
  const supabase = getSupabaseAdminClient();
  if (!supabase) return <ErrorState title="Customer issues unavailable" body="Could not connect to customer support. No empty history is being inferred." />;
  let query = supabase.from("issues").select("id, issue_type, priority, status, description, customer_name, customer_phone, contact_channel, created_at, machines(name, location:locations(name))", { count: "exact" }).order("created_at", { ascending: false });
  if (type) query = query.ilike("issue_type", supabaseLikePattern(type));
  const { data: issues, count, error } = await query.range(from, to);
  if (error) {
    console.error("[issues] Failed to load customer issues", error);
    return <ErrorState title="Could not load customer issues" body="Customer support data or its database update could not be loaded. Retry; your existing issues have not been removed." action={<SecondaryButton href="/issues">Retry</SecondaryButton>} />;
  }
  return <>
    <PageHeader title="Customer Issues / بلاغات العملاء" subtitle="Track customer reports and machine incidents separately from business-development leads and visits." breadcrumbs={[{ label: "Snacky CRM", href: "/locations-pipeline" }, { label: "Customer Issues" }]} action={canCreate ? <PrimaryButton href="/issues/new">Add issue / إضافة بلاغ</PrimaryButton> : null} />
    {!issues?.length ? <div className="surface-card"><EmptyState title={type ? "No matching issues" : "No customer issues yet"} body="Record customer calls and messages here. Operator-reported machine problems remain visible too." />{canCreate ? <PrimaryButton href="/issues/new">Add first issue / إضافة بلاغ</PrimaryButton> : null}</div> : <>
      <DataTable headers={["Date", "Machine / location", "Customer", "Phone / WhatsApp", "Channel", "Type", "Priority", "Status", "Description"]}>
        {issues.map((issue: any) => <tr key={issue.id}>
          <td>{String(issue.created_at).slice(0,10)}</td><td className="font-medium">{issue.machines?.location?.name ?? issue.machines?.name ?? "General / unknown"}</td>
          <td>{issue.customer_name ?? "—"}</td><td dir="ltr">{issue.customer_phone ?? "—"}</td><td>{issue.contact_channel ?? "other"}</td>
          <td>{String(issue.issue_type).replaceAll("_", " ")}</td><td><StatusBadge status={issue.priority} /></td><td><StatusBadge status={issue.status} /></td><td className="max-w-md whitespace-pre-wrap">{issue.description}</td>
        </tr>)}
      </DataTable>
      <PaginationControls basePath="/issues" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="issues" />
    </>}
  </>;
}
