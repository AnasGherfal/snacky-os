import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function createLocation(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;
  const payload = {
    name: String(formData.get("name") || "").trim(),
    location_type: String(formData.get("location_type") || "other"),
    rent_amount: Number(formData.get("rent_amount") || 0),
    status: String(formData.get("status") || "active"),
    latitude: optionalNumber(formData.get("latitude")),
    longitude: optionalNumber(formData.get("longitude")),
    distance_zone: String(formData.get("distance_zone") || "within_10_km"),
    access_difficulty: String(formData.get("access_difficulty") || "normal"),
    stop_multiplier: Number(formData.get("stop_multiplier") || 1),
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
              <FormField label="Latitude" hint="Optional for route distance and map linking later.">
                <input type="number" step="0.00000001" name="latitude" className="field-input" placeholder="32.8872" />
              </FormField>
              <FormField label="Longitude" hint="Optional for route distance and map linking later.">
                <input type="number" step="0.00000001" name="longitude" className="field-input" placeholder="13.1913" />
              </FormField>
              <FormField label="Distance zone" required hint="Used by the first payroll engine before map API routing is added.">
                <select name="distance_zone" className="field-input" defaultValue="within_10_km">
                  <option value="within_10_km">0-10 km</option>
                  <option value="km_11_20">11-20 km</option>
                  <option value="km_21_35">21-35 km</option>
                  <option value="km_36_50">36-50 km</option>
                  <option value="km_51_70">51-70 km</option>
                  <option value="km_70_plus">70+ km</option>
                </select>
              </FormField>
              <FormField label="Access difficulty" required hint="Operational difficulty for parking, stairs, permissions, or carrying stock.">
                <select name="access_difficulty" className="field-input" defaultValue="normal">
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard</option>
                  <option value="very_hard">Very hard</option>
                </select>
              </FormField>
              <FormField label="Stop multiplier" hint="Used by route pay as stop_rate x stop_multiplier.">
                <input type="number" step="0.1" min="0.1" name="stop_multiplier" className="field-input" placeholder="1.0" defaultValue="1" />
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
