import { redirect } from "next/navigation";
import { BusinessRecordForm } from "@/components/BusinessRecordForm";
import { ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { businessDate } from "@/lib/business-record-validation";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export default async function NewCustomerIssuePage() {
  const profile = await requireCurrentProfileForPath("/issues/new");
  if (!hasPermission(profile, "issues.view") || !hasPermission(profile, "issues.create")) redirect("/operator/issues");
  const supabase = getSupabaseAdminClient();
  if (!supabase) return <ErrorState title="Customer support unavailable" body="Could not connect to the machine list. No issue was recorded." />;
  // Management/support may choose any machine. Operator route reporting keeps
  // its existing, separate assignment checks; no financial fields are loaded.
  const { data, error } = await supabase.from("machines").select("id, name, machine_code, location:locations(name)").order("name");
  if (error) return <ErrorState title="Could not load machines" body="Reload before selecting a machine for the customer issue." action={<SecondaryButton href="/issues/new">Retry</SecondaryButton>} />;
  const machines = (data ?? []).map((machine) => {
    const location = Array.isArray(machine.location) ? machine.location[0] : machine.location;
    return { id: String(machine.id), label: [location?.name, machine.name, machine.machine_code].filter(Boolean).join(" · ") || String(machine.id).slice(0,8) };
  });
  return <>
    <PageHeader title="Add customer issue / إضافة بلاغ عميل" subtitle="Record a customer call, WhatsApp message, or machine complaint without creating a route." breadcrumbs={[{ label: "Snacky CRM", href: "/locations-pipeline" }, { label: "Customer Issues", href: "/issues" }, { label: "Add issue" }]} action={<SecondaryButton href="/issues">Back to issues</SecondaryButton>} />
    <BusinessRecordForm kind="issue" userId={profile.id} today={businessDate()} machines={machines} />
  </>;
}
