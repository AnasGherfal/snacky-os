import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

async function createLocation(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;
  const payload = {
    name: String(formData.get("name") || "").trim(),
    location_type: String(formData.get("location_type") || "other"),
    rent_amount: Number(formData.get("rent_amount") || 0),
    status: String(formData.get("status") || "active"),
  };
  if (!payload.name) return;
  await supabase.from("locations").insert(payload);
  revalidatePath("/locations");
  redirect("/locations");
}

export default function NewLocationPage() {
  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New Location"
          subtitle="Create a site record for machines, rent, and operating context."
          breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations", href: "/locations" }, { label: "New location" }]}
          action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
        />
        <LocalDraftForm action={createLocation} formType="location" draftKeyParts={["new"]} className="space-y-5">
          <FormSection title="Location details" description="Use a clear customer/site name and classify the venue so machines and rent reports stay readable.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Location name" required>
                <input required name="name" className="field-input" placeholder="Location name" />
              </FormField>
              <FormField label="Location type" required hint="Examples: school, hospital, office, gym, mall, other.">
                <input required name="location_type" className="field-input" placeholder="school" />
              </FormField>
              <FormField label="Rent amount">
                <input type="number" step="0.01" min="0" name="rent_amount" className="field-input" placeholder="0.00" />
              </FormField>
              <FormField label="Status">
                <select name="status" className="field-input" defaultValue="active">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
            </div>
          </FormSection>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Add location</PrimaryButton>
            <SecondaryButton href="/locations">Cancel</SecondaryButton>
          </div>
        </LocalDraftForm>
      </FormPageLayout>
    </>
  );
}
