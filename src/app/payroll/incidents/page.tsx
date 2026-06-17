import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel } from "@/lib/payroll";
import { approveOperatorIncident, cancelOperatorIncident, createOperatorIncident } from "@/lib/payroll-v2-actions";
import { getPayrollV2ServerClient, type OperatorIncidentRow } from "@/lib/payroll-v2";

export const dynamic = "force-dynamic";

type TeamMemberRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
};

type RouteRow = {
  id: string;
  route_date?: string | null;
};

type MachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
};

type LocationRow = {
  id: string;
  name?: string | null;
};

const incidentTypes = [
  "missed_cleaning",
  "missing_photo",
  "wrong_product_slot",
  "wrong_prices",
  "machine_left_unusable",
  "customer_money_issue",
  "cash_mismatch",
  "poor_machine_presentation",
  "location_complaint",
  "ignored_customer_issue",
  "other",
];

const severities = [
  "level_1_small",
  "level_2_medium",
  "level_3_serious",
  "level_4_critical",
];

export default async function PayrollIncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Operator incidents unavailable" body="Supabase is not configured, so Snacky OS cannot load operator deductions." />
      </>
    );
  }

  const [{ data: operators, error: operatorsError }, { data: incidents, error: incidentsError }, { data: routes }, { data: machines }, { data: locations }] = await Promise.all([
    supabase
      .from("team_members")
      .select("id, full_name, role, roles")
      .or("role.in.(owner,admin,supervisor,operator),roles.ov.{owner,admin,supervisor,operator}")
      .order("full_name"),
    supabase.from("operator_incidents").select("*").order("incident_date", { ascending: false }).order("created_at", { ascending: false }).limit(100),
    supabase.from("routes").select("id, route_date").order("route_date", { ascending: false }).limit(50),
    supabase.from("machines").select("id, name, machine_code").order("name"),
    supabase.from("locations").select("id, name").order("name"),
  ]);

  if (operatorsError || incidentsError) {
    console.error("[payroll:incidents] Failed to load incidents page", { operatorsError, incidentsError });
    return (
      <>
        <ErrorState
          title="Could not load operator incidents"
          body="Snacky OS could not load operator incident deductions."
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />
      </>
    );
  }

  const operatorById = new Map(((operators ?? []) as TeamMemberRow[]).map((row) => [row.id, row.full_name ?? "Operator"]));
  const routeById = new Map(((routes ?? []) as RouteRow[]).map((row) => [row.id, row.route_date ?? row.id.slice(0, 8)]));
  const machineById = new Map(((machines ?? []) as MachineRow[]).map((row) => [row.id, `${row.name ?? "Unknown machine"}${row.machine_code ? ` (${row.machine_code})` : ""}`]));
  const locationById = new Map(((locations ?? []) as LocationRow[]).map((row) => [row.id, row.name ?? "Unknown location"]));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Operator Incidents / مخالفات المشغلين"
          subtitle="Create the incident first, approve or cancel it after review, and only then let it flow into payroll."
          breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Operator incidents" }]}
          action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>}
        />

        {params.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
        {params.saved ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Incident changes saved.</div> : null}

        <FormSection title="Create incident" description="Use a clear description. The severity can guide the owner, but the final deduction amount is chosen manually.">
          <form action={createOperatorIncident} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <FormField label="Operator" required>
              <select name="operator_id" className="field-input" defaultValue="">
                <option value="">Choose operator</option>
                {((operators ?? []) as TeamMemberRow[]).map((operator) => (
                  <option key={operator.id} value={operator.id}>{operator.full_name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Incident date" required>
              <input type="date" name="incident_date" defaultValue={today} className="field-input" />
            </FormField>
            <FormField label="Mistake type" required>
              <select name="mistake_type" defaultValue="other" className="field-input">
                {incidentTypes.map((type) => (
                  <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Severity" required hint="Level 1: 0-10 LYD, Level 2: 10-30, Level 3: 30-100, Level 4: 100+ or manual owner decision.">
              <select name="severity" defaultValue="level_1_small" className="field-input">
                {severities.map((severity) => (
                  <option key={severity} value={severity}>{severity.replaceAll("_", " ")}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Deduction amount LYD" required>
              <input type="number" name="deduction_amount_lyd" min="0" step="0.01" defaultValue="0" className="field-input" />
            </FormField>
            <FormField label="Route (optional)">
              <select name="route_id" defaultValue="" className="field-input">
                <option value="">No route link</option>
                {((routes ?? []) as RouteRow[]).map((route) => (
                  <option key={route.id} value={route.id}>{route.route_date ?? route.id}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Route stop ID (optional)">
              <input name="stop_id" className="field-input" placeholder="Paste route stop id if needed" />
            </FormField>
            <FormField label="Machine (optional)">
              <select name="machine_id" defaultValue="" className="field-input">
                <option value="">No machine link</option>
                {((machines ?? []) as MachineRow[]).map((machine) => (
                  <option key={machine.id} value={machine.id}>{machine.name}{machine.machine_code ? ` (${machine.machine_code})` : ""}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Location (optional)">
              <select name="location_id" defaultValue="" className="field-input">
                <option value="">No location link</option>
                {((locations ?? []) as LocationRow[]).map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            </FormField>
            <div className="md:col-span-2 xl:col-span-3">
              <FormField label="Description" required>
                <textarea name="description" rows={3} className="field-input" placeholder="What exactly happened, and why should this be reviewed?" />
              </FormField>
            </div>
            <FormField label="Evidence photo URL">
              <input name="evidence_photo_url" className="field-input" placeholder="Optional photo or evidence link" />
            </FormField>
            <div className="md:col-span-2">
              <FormField label="Notes">
                <input name="notes" className="field-input" placeholder="Optional owner note or context" />
              </FormField>
            </div>
            <div className="xl:col-span-3">
              <PrimaryButton>Create incident</PrimaryButton>
            </div>
          </form>
        </FormSection>

        <FormSection title="Incidents list" description="Only approved incidents can flow into payroll. Once a run picks them up, they move to applied to payroll.">
          {!incidents?.length ? (
            <EmptyState title="No incidents yet" body="Create an incident above when an operator issue should be reviewed for deduction." />
          ) : (
            <DataTable headers={["Date", "Operator", "Issue", "Severity", "Deduction", "Status", "Links", "Action"]}>
              {((incidents ?? []) as OperatorIncidentRow[]).map((incident) => (
                <tr key={incident.id}>
                  <td>{incident.incident_date ?? "-"}</td>
                  <td className="font-medium text-slate-900">{operatorById.get(incident.operator_id) ?? "Operator"}</td>
                  <td>
                    <div className="font-medium text-slate-900">{incident.description ?? "-"}</div>
                    <div className="text-xs text-slate-500">{String(incident.mistake_type ?? "other").replaceAll("_", " ")}</div>
                  </td>
                  <td><StatusBadge status={incident.severity} /></td>
                  <td>{moneyLabel(incident.deduction_amount_lyd ?? 0)}</td>
                  <td><StatusBadge status={incident.status} /></td>
                  <td>
                    <div className="space-y-1 text-sm">
                      <div>{incident.route_id ? <Link href={`/routes/${incident.route_id}`} className="link-secondary">Route {routeById.get(incident.route_id) ?? incident.route_id.slice(0, 8)}</Link> : "No route"}</div>
                      <div>{incident.machine_id ? machineById.get(incident.machine_id) ?? "Unknown machine" : "No machine"}</div>
                      <div>{incident.location_id ? locationById.get(incident.location_id) ?? "Unknown location" : "No location"}</div>
                    </div>
                  </td>
                  <td>
                    {incident.status === "pending" || incident.status === "cancelled" ? (
                      <form action={approveOperatorIncident} className="mb-2">
                        <input type="hidden" name="incident_id" value={incident.id} />
                        <button className="btn-secondary">Approve</button>
                      </form>
                    ) : null}
                    {incident.status === "pending" || incident.status === "approved" ? (
                      <ConfirmDialog
                        action={cancelOperatorIncident}
                        triggerLabel="Cancel"
                        title="Cancel this incident?"
                        description="Cancelled incidents will not be included in payroll."
                        confirmLabel="Cancel incident"
                        buttonClassName="btn-danger"
                        confirmButtonClassName="btn-danger"
                        hiddenFields={[{ name: "incident_id", value: incident.id }]}
                      />
                    ) : incident.status === "applied_to_payroll" ? (
                      <span className="text-sm text-slate-500">Locked by payroll</span>
                    ) : (
                      <span className="text-sm text-slate-500">No action</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </FormSection>
      </FormPageLayout>
    </>
  );
}
