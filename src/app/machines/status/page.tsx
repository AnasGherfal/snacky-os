import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const machineStatuses = ["planned", "incoming", "standby", "active", "inactive", "maintenance", "relocated", "retired"];

export default async function MachineStatusPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Machine status unavailable" body="Supabase is not configured, so Snacky OS cannot load machine status." />
      </>
    );
  }

  const [{ data, count, error }, statusCountsResults] = await Promise.all([
    supabase
    .from("machines")
      .select("id, machine_code, name, status, machine_type, locations(name)", { count: "exact" })
    .order("status")
      .order("name")
      .range(from, to),
    Promise.all(machineStatuses.map((status) => supabase.from("machines").select("id", { count: "exact", head: true }).eq("status", status))),
  ]);

  if (error) {
    console.error("[machines] Failed to load machine status", error);
    return (
      <>
        <ErrorState title="Could not load machine status" body="Snacky OS could not load machine status records from Supabase." action={<SecondaryButton href="/machines/status">Retry</SecondaryButton>} />
      </>
    );
  }

  const rows = data ?? [];
  const statusCounts = Object.fromEntries(machineStatuses.map((status, index) => [status, statusCountsResults[index]?.count ?? 0]));

  return (
    <>
      <PageHeader
        title="Machine Status"
        subtitle="Current operational status for every machine in the network."
        breadcrumbs={[
          { label: "Machines", href: "/machines" },
          { label: "Status" },
        ]}
      />

      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Object.entries(statusCounts).map(([status, count]) => (
          <div key={status} className="surface-card">
            <div className="text-sm text-slate-500">{status.replaceAll("_", " ")}</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{count}</div>
          </div>
        ))}
      </section>

      {!rows.length ? (
        <EmptyState title="No machines yet" body="Create machines before tracking machine status." />
      ) : (
        <>
          <DataTable headers={["Code", "Name", "Type", "Location", "Status", "Actions"]}>
            {rows.map((machine: any) => (
              <tr key={machine.id}>
                <td>{machine.machine_code}</td>
                <td className="font-medium text-slate-900">{machine.name}</td>
                <td>{machine.machine_type}</td>
                <td>{machine.locations?.name ?? "-"}</td>
                <td><StatusBadge status={machine.status} /></td>
                <td><Link href={`/machines/${machine.id}/edit`} className="btn-secondary">Edit</Link></td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/machines/status" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="machines" />
        </>
      )}
    </>
  );
}
