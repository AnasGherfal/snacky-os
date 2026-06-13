import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { EmptyState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function saveLocation(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;
  const id = String(formData.get("id") || "");
  await supabase
    .from("locations")
    .update({
      name: String(formData.get("name") || "").trim(),
      location_type: String(formData.get("location_type") || "other"),
      rent_amount: Number(formData.get("rent_amount") || 0),
      status: String(formData.get("status") || "active"),
      latitude: optionalNumber(formData.get("latitude")),
      longitude: optionalNumber(formData.get("longitude")),
      distance_zone: String(formData.get("distance_zone") || "within_10_km"),
      access_difficulty: String(formData.get("access_difficulty") || "normal"),
      stop_multiplier: Number(formData.get("stop_multiplier") || 1),
    })
    .eq("id", id);
  revalidatePath("/locations");
  redirect("/locations");
}

export default async function EditLocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { data: location } = supabase ? await supabase.from("locations").select("*").eq("id", id).maybeSingle() : { data: null };

  if (!location) {
    return (
      <>
        <EmptyState title="Location not found" body="This location may have been removed or you may not have access to it." action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={`Edit location: ${location.name}`}
          subtitle="Update site classification, rent, and active status."
          breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations", href: "/locations" }, { label: location.name }]}
          action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
        />
        <LocalDraftForm action={saveLocation} formType="location" draftKeyParts={[location.id]} className="space-y-5">
          <input type="hidden" name="id" value={location.id} />
          <FormSection title="Location details" description="Keep this site record readable for machine setup, rent reports, and operations review.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Location name" required>
                <input required name="name" defaultValue={location.name} className="field-input" />
              </FormField>
              <FormField label="Location type" required>
                <input required name="location_type" defaultValue={location.location_type} className="field-input" />
              </FormField>
              <FormField label="Rent amount">
                <input type="number" step="0.01" min="0" name="rent_amount" defaultValue={location.rent_amount} className="field-input" />
              </FormField>
              <FormField label="Status">
                <select name="status" defaultValue={location.status ?? "active"} className="field-input">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
              <FormField label="Latitude">
                <input type="number" step="0.00000001" name="latitude" defaultValue={location.latitude ?? ""} className="field-input" />
              </FormField>
              <FormField label="Longitude">
                <input type="number" step="0.00000001" name="longitude" defaultValue={location.longitude ?? ""} className="field-input" />
              </FormField>
              <FormField label="Distance zone" required>
                <select name="distance_zone" defaultValue={location.distance_zone ?? "within_10_km"} className="field-input">
                  <option value="within_10_km">0-10 km</option>
                  <option value="km_11_20">11-20 km</option>
                  <option value="km_21_35">21-35 km</option>
                  <option value="km_36_50">36-50 km</option>
                  <option value="km_51_70">51-70 km</option>
                  <option value="km_70_plus">70+ km</option>
                </select>
              </FormField>
              <FormField label="Access difficulty" required>
                <select name="access_difficulty" defaultValue={location.access_difficulty ?? "normal"} className="field-input">
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard</option>
                  <option value="very_hard">Very hard</option>
                </select>
              </FormField>
              <FormField label="Stop multiplier">
                <input type="number" step="0.1" min="0.1" name="stop_multiplier" defaultValue={location.stop_multiplier ?? 1} className="field-input" />
              </FormField>
            </div>
          </FormSection>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Save changes</PrimaryButton>
            <SecondaryButton href="/locations">Cancel</SecondaryButton>
          </div>
        </LocalDraftForm>
      </FormPageLayout>
    </>
  );
}
