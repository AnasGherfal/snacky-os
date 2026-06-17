import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { formatSiteLabel } from "@/lib/machine-site-display";

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isMissingColumnError(error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function createMachine(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;

  const profile = await getCurrentProfile();
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

  if (!payload.machine_code || !payload.name) return;

  let insertResult = await supabase
    .from("machines")
    .insert(payload)
    .select("id, machine_code, machine_display_name, name, status, location_id")
    .single();
  if (insertResult.error && isMissingColumnError(insertResult.error)) {
    insertResult = await supabase
      .from("machines")
      .insert({
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
      .select("id, machine_code, name, status, location_id")
      .single();
  }
  if (insertResult.data) {
    await logActivity({
      profile,
      action: "create",
      entityType: "machine",
      entityId: insertResult.data.id,
      entityLabel: insertResult.data.machine_display_name ?? insertResult.data.name,
      afterData: insertResult.data,
      summary: `Created machine ${insertResult.data.machine_display_name ?? insertResult.data.name}`,
    });
  }

  revalidatePath("/machines");
  redirect("/machines");
}

export default async function NewMachinePage() {
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { data: locations } = supabase
    ? await supabase.from("locations").select("*").order("name")
    : { data: [] };

  return (
    <FormPageLayout>
      <PageHeader title="Create machine" subtitle="Keep the physical machine identity permanent, then attach or move it between sites later." breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Create machine" }]} />
      <LocalDraftForm action={createMachine} formType="machine" draftKeyParts={["new"]} className="space-y-5">
        <FormSection title="Machine details" description="Machine code and machine display name belong to the physical unit, not the site.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Machine code" required hint="Permanent Snacky code, for example SNK-001.">
              <input required name="machine_code" placeholder="SNK-001" className="field-input" />
            </FormField>
            <FormField label="Machine display name" required hint="Usually keep this equal to the machine code so the physical unit stays identifiable after relocations.">
              <input required name="machine_display_name" placeholder="SNK-001" className="field-input" />
            </FormField>
            <FormField label="VMS Machine ID" hint="The exact machine ID/code used in the VMS export.">
              <input name="vms_machine_id" placeholder="VMS-AB12" className="field-input" />
            </FormField>
            <FormField label="Serial number">
              <input name="serial_number" placeholder="Optional serial number" className="field-input" />
            </FormField>
            <FormField label="Machine type" required>
              <select name="machine_type" className="field-input" defaultValue="lift">
                <option value="lift">lift</option>
                <option value="non-lift">non-lift</option>
                <option value="coffee">coffee</option>
                <option value="other">other</option>
              </select>
            </FormField>
            <FormField label="Status" required>
              <select name="status" className="field-input" defaultValue="active">
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
        <FormSection title="Active site" description="Link the machine to the exact current site now, or leave it empty and assign it later.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Current active site">
              <select name="location_id" className="field-input" defaultValue="">
                <option value="">No site assigned yet</option>
                {(locations ?? []).map((location: any) => (
                  <option key={location.id} value={location.id}>
                    {formatSiteLabel(location, { includeArea: true, fallback: location.name ?? "Unknown site" })}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Rent LYD" hint="Monthly rent paid for this site, if applicable.">
              <input type="number" step="0.01" name="rent_amount" placeholder="0.00" className="field-input" />
            </FormField>
            <FormField label="Target NSM" hint="Target net sales per month for this machine.">
              <input type="number" step="0.01" name="target_nsm" placeholder="2800" className="field-input" />
            </FormField>
            <FormField label="Target Uptime %" hint="Target machine uptime, usually 98%.">
              <input type="number" step="0.01" name="target_uptime_percent" placeholder="98" className="field-input" />
            </FormField>
          </div>
        </FormSection>
        <div className="flex gap-3">
          <PrimaryButton>Save machine</PrimaryButton>
          <SecondaryButton href="/machines">Cancel</SecondaryButton>
        </div>
      </LocalDraftForm>
    </FormPageLayout>
  );
}
