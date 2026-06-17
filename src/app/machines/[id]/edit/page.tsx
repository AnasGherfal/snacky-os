import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { formatSiteLabel, machineBaseLabel } from "@/lib/machine-site-display";

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isMissingColumnError(error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function updateMachine(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;

  const profile = await getCurrentProfile();
  const id = String(formData.get("id") || "").trim();
  const { data: beforeMachine } = await supabase.from("machines").select("*").eq("id", id).maybeSingle();
  const machineCode = String(formData.get("machine_code") || "").trim();
  const machineDisplayName = String(formData.get("machine_display_name") || machineCode).trim() || machineCode;
  const payload = {
    machine_code: machineCode,
    machine_display_name: machineDisplayName,
    vms_machine_id: cleanText(formData.get("vms_machine_id")),
    name: machineDisplayName,
    serial_number: cleanText(formData.get("serial_number")),
    machine_type: String(formData.get("machine_type") || "lift"),
    location_id: cleanText(formData.get("location_id")),
    rent_amount: Number(formData.get("rent_amount") || 0),
    status: String(formData.get("status") || "active"),
    target_nsm: Number(formData.get("target_nsm") || 0),
    target_uptime_percent: Number(formData.get("target_uptime_percent") || 98),
  };

  let updateResult = await supabase
    .from("machines")
    .update(payload)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (updateResult.error && isMissingColumnError(updateResult.error)) {
    updateResult = await supabase
      .from("machines")
      .update({
        machine_code: payload.machine_code,
        vms_machine_id: payload.vms_machine_id,
        name: payload.name,
        serial_number: payload.serial_number,
        machine_type: payload.machine_type,
        location_id: payload.location_id,
        rent_amount: payload.rent_amount,
        status: payload.status,
        target_nsm: payload.target_nsm,
        target_uptime_percent: payload.target_uptime_percent,
      })
      .eq("id", id)
      .select("*")
      .maybeSingle();
  }
  const afterMachine = updateResult.data;

  await logActivity({
    profile,
    action: "update",
    entityType: "machine",
    entityId: id,
    entityLabel: afterMachine?.machine_display_name ?? afterMachine?.name ?? payload.name,
    beforeData: beforeMachine,
    afterData: afterMachine ?? payload,
    summary: `Updated machine ${afterMachine?.machine_display_name ?? afterMachine?.name ?? payload.name}`,
  });
  revalidatePath("/machines");
  redirect("/machines");
}

export default async function EditMachinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) notFound();

  const [{ data: machine }, { data: locations }] = await Promise.all([
    supabase.from("machines").select("*").eq("id", id).single(),
    supabase.from("locations").select("*").order("name"),
  ]);
  if (!machine) notFound();

  return (
    <FormPageLayout>
      <PageHeader
        title="Edit machine"
        subtitle="Update the permanent machine identity separately from the current active site."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: machineBaseLabel(machine) }, { label: "Edit machine" }]}
      />
      <LocalDraftForm action={updateMachine} formType="machine" draftKeyParts={[id]} className="space-y-5">
        <input type="hidden" name="id" value={id} />
        <FormSection title="Machine details" description="These values belong to the physical machine and should stay stable even when the site changes.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Machine code" required>
              <input required name="machine_code" defaultValue={machine.machine_code} className="field-input" />
            </FormField>
            <FormField label="Machine display name" required>
              <input required name="machine_display_name" defaultValue={machine.machine_display_name ?? machine.machine_code ?? machine.name} className="field-input" />
            </FormField>
            <FormField label="VMS Machine ID">
              <input name="vms_machine_id" defaultValue={machine.vms_machine_id || ""} className="field-input" />
            </FormField>
            <FormField label="Serial number">
              <input name="serial_number" defaultValue={machine.serial_number || ""} className="field-input" />
            </FormField>
            <FormField label="Machine type" required>
              <select name="machine_type" defaultValue={machine.machine_type} className="field-input">
                <option value="lift">lift</option>
                <option value="non-lift">non-lift</option>
                <option value="coffee">coffee</option>
                <option value="other">other</option>
              </select>
            </FormField>
            <FormField label="Status" required>
              <select name="status" defaultValue={machine.status} className="field-input">
                <option value="planned">planned</option>
                <option value="standby">standby</option>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="maintenance">maintenance</option>
                <option value="incoming">incoming</option>
                <option value="relocated">relocated</option>
                <option value="retired">retired</option>
              </select>
            </FormField>
          </div>
        </FormSection>
        <FormSection title="Active site" description="Choose the exact current site here. The area stays with the location record, not the machine itself.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Current active site">
              <select name="location_id" defaultValue={machine.location_id || ""} className="field-input">
                <option value="">No site assigned</option>
                {locations?.map((location: any) => (
                  <option key={location.id} value={location.id}>
                    {formatSiteLabel(location, { includeArea: true, fallback: location.name ?? "Unknown site" })}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Rent LYD">
              <input type="number" step="0.01" name="rent_amount" defaultValue={machine.rent_amount ?? 0} className="field-input" />
            </FormField>
            <FormField label="Target NSM">
              <input type="number" step="0.01" name="target_nsm" defaultValue={machine.target_nsm ?? 0} className="field-input" />
            </FormField>
            <FormField label="Target Uptime %">
              <input type="number" step="0.01" name="target_uptime_percent" defaultValue={machine.target_uptime_percent ?? 98} className="field-input" />
            </FormField>
          </div>
        </FormSection>
        <div className="flex gap-3">
          <PrimaryButton>Save changes</PrimaryButton>
          <SecondaryButton href="/machines">Cancel</SecondaryButton>
        </div>
      </LocalDraftForm>
    </FormPageLayout>
  );
}
