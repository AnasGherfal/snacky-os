import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";

async function createMachine(fd: FormData) {"use server";
 const s=await getAuthenticatedSupabaseServerClient(); if(!s) return;
 const profile = await getCurrentProfile();
 const payload={machine_code:String(fd.get("machine_code")||"").trim(),vms_machine_id:String(fd.get("vms_machine_id")||"")||null,name:String(fd.get("name")||"").trim(),machine_type:String(fd.get("machine_type")||"lift"),location_id:String(fd.get("location_id")||"")||null,rent_amount:Number(fd.get("rent_amount")||0),status:String(fd.get("status")||"active"),target_nsm:Number(fd.get("target_nsm")||0),target_uptime_percent:Number(fd.get("target_uptime_percent")||98)};
 if(!payload.machine_code||!payload.name) return; const { data } = await s.from("machines").insert(payload).select("id, machine_code, name, status, location_id").single(); if (data) { await logActivity({ profile, action: "create", entityType: "machine", entityId: data.id, entityLabel: data.name, afterData: data, summary: `Created machine ${data.name}` }); } revalidatePath("/machines"); redirect("/machines"); }

export default async function NewMachinePage(){const s=await getAuthenticatedSupabaseServerClient(); const {data:locations}=s?await s.from("locations").select("id,name").order("name"):{data:[]};
return <><FormPageLayout><PageHeader title="Create machine" subtitle="Add a machine record with operational targets." breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Create machine" }]} />
<LocalDraftForm action={createMachine} formType="machine" draftKeyParts={["new"]} className="space-y-5"><FormSection title="Machine details"><div className="grid gap-4 md:grid-cols-2">
<FormField label="Internal Machine Code" required hint="Snacky's internal code, e.g. SNK-001."><input required name="machine_code" placeholder="SNK-001" className="field-input"/></FormField>
<FormField label="VMS Machine ID" hint="The exact machine ID/code used in the VMS export."><input name="vms_machine_id" placeholder="VMS-AB12" className="field-input"/></FormField>
<FormField label="Machine Name" required hint="Friendly name shown in dashboards and routes."><input required name="name" placeholder="Benghazi Mall - Entrance" className="field-input"/></FormField>
<FormField label="Machine Type" required><select name="machine_type" className="field-input"><option>lift</option><option>non-lift</option><option>coffee</option><option>other</option></select></FormField>
<FormField label="Location" hint="Where this machine is installed."><select name="location_id" className="field-input"><option value="">Select location</option>{locations?.map((l:any)=><option key={l.id} value={l.id}>{l.name}</option>)}</select></FormField>
<FormField label="Status" required><select name="status" className="field-input"><option>active</option><option>inactive</option><option>maintenance</option><option>incoming</option><option>relocated</option></select></FormField>
<FormField label="Rent LYD" hint="Monthly rent paid for this location, if applicable."><input type="number" step="0.01" name="rent_amount" placeholder="0.00" className="field-input"/></FormField>
<FormField label="Target NSM" hint="Target net sales per month for this machine."><input type="number" step="0.01" name="target_nsm" placeholder="2800" className="field-input"/></FormField>
<FormField label="Target Uptime %" hint="Target machine uptime, usually 98%."><input type="number" step="0.01" name="target_uptime_percent" placeholder="98" className="field-input"/></FormField>
</div></FormSection><div className="flex gap-3"><PrimaryButton>Save machine</PrimaryButton><SecondaryButton href="/machines">Cancel</SecondaryButton></div></LocalDraftForm></FormPageLayout></>}
