import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function MachineMaintenancePage() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Maintenance unavailable" body="Supabase is not configured, so Snacky OS cannot load maintenance records." />
      </>
    );
  }

  const [{ data: machines, error: machinesError }, { data: issues, error: issuesError }] = await Promise.all([
    supabase.from("machines").select("id, machine_code, name, status, locations(name)").eq("status", "maintenance").order("name"),
    supabase.from("issues").select("id, issue_type, priority, status, description, machines(name)").order("created_at", { ascending: false }),
  ]);

  const loadError = machinesError ?? issuesError;
  if (loadError) {
    console.error("[machines] Failed to load maintenance", loadError);
    return (
      <>
        <ErrorState title="Could not load maintenance" body="Snacky OS could not load maintenance machines or issues from Supabase." action={<SecondaryButton href="/machines/maintenance">Retry</SecondaryButton>} />
      </>
    );
  }

  const maintenanceIssues = (issues ?? []).filter((issue: any) => String(issue.issue_type ?? "").toLowerCase().includes("maintenance"));

  return (
    <>
      <PageHeader
        title="Maintenance"
        subtitle="Machines currently in maintenance and open maintenance-labelled issues."
        breadcrumbs={[
          { label: "Machines", href: "/machines" },
          { label: "Maintenance" },
        ]}
      />

      <section className="mb-6">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Machines in maintenance</h2>
        {!machines?.length ? (
          <EmptyState title="No machines in maintenance" body="Machines marked maintenance will appear here." />
        ) : (
          <DataTable headers={["Code", "Name", "Location", "Status"]}>
            {machines.map((machine: any) => (
              <tr key={machine.id}>
                <td>{machine.machine_code}</td>
                <td className="font-medium text-slate-900">{machine.name}</td>
                <td>{machine.locations?.name ?? "-"}</td>
                <td><StatusBadge status={machine.status} /></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section>
        {!maintenanceIssues.length ? (
          <EmptyState title="No maintenance issues" body="Maintenance-labelled operator issues will appear here." />
        ) : (
          <DataTable headers={["Machine", "Type", "Priority", "Status", "Description"]}>
            {maintenanceIssues.map((issue: any) => (
              <tr key={issue.id}>
                <td className="font-medium text-slate-900">{issue.machines?.name ?? "-"}</td>
                <td>{issue.issue_type}</td>
                <td><StatusBadge status={issue.priority} /></td>
                <td><StatusBadge status={issue.status} /></td>
                <td>{issue.description}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
