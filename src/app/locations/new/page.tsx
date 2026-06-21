import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { buildLocationLegacyPayload, buildLocationMinimalPayload, buildLocationPayload, LOCATION_TYPE_OPTIONS, normalizeLocationType } from "@/lib/location-records";

type StorageLocationRow = {
  id: string;
  name?: string | null;
};

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingColumnError(error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

async function createLocation(formData: FormData) {
  "use server";
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return;

  const siteName = String(formData.get("site_name") || "").trim();
  if (!siteName) return;

  const draft = {
    site_name: siteName,
    area: cleanText(formData.get("area")),
    city: cleanText(formData.get("city")),
    address_text: cleanText(formData.get("address_text")),
    google_maps_url: cleanText(formData.get("google_maps_url")),
    contact_person_name: cleanText(formData.get("contact_person_name")),
    contact_person_phone: cleanText(formData.get("contact_person_phone")),
    location_type: normalizeLocationType(formData.get("location_type")),
    rent_amount: Number(formData.get("rent_amount") || 0),
    status: String(formData.get("status") || "active"),
    notes: cleanText(formData.get("notes")),
    latitude: optionalNumber(formData.get("latitude")),
    longitude: optionalNumber(formData.get("longitude")),
    distance_zone: String(formData.get("distance_zone") || "within_10_km"),
    access_difficulty: String(formData.get("access_difficulty") || "normal"),
    stop_multiplier: Number(formData.get("stop_multiplier") || 1),
    payroll_storage_location_id: cleanText(formData.get("payroll_storage_location_id")),
    distance_from_storage_km: optionalNumber(formData.get("distance_from_storage_km")),
    use_round_trip_distance: String(formData.get("use_round_trip_distance") || "") === "yes",
    payroll_distance_notes: cleanText(formData.get("payroll_distance_notes")),
  };

  let insertResult = await supabase.from("locations").insert(buildLocationPayload(draft));
  if (insertResult.error && isMissingColumnError(insertResult.error)) {
    insertResult = await supabase.from("locations").insert(buildLocationLegacyPayload(draft));
  }
  if (insertResult.error && isMissingColumnError(insertResult.error)) {
    insertResult = await supabase.from("locations").insert(buildLocationMinimalPayload(draft));
  }
  if (insertResult.error) {
    console.error("[locations] Failed to create location", {
      table: "locations",
      payload: draft,
      error: insertResult.error,
    });
  }

  revalidatePath("/locations");
  redirect("/locations");
}

export default async function NewLocationPage() {
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { data: storageLocations } = supabase
    ? await supabase.from("storage_locations").select("id, name").eq("active", true).order("name")
    : { data: [] };

  return (
    <FormPageLayout>
      <PageHeader
        title="New Active Site"
        subtitle="Create the exact customer site first, then link or move machines later without losing the permanent machine code."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations", href: "/locations" }, { label: "New location" }]}
        action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
      />
      <LocalDraftForm action={createLocation} formType="location" draftKeyParts={["new"]} className="space-y-5">
        <FormSection title="Site details" description="Separate the exact site from the broader area so routes, payroll, and machine history stay clear.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Exact site name" required hint="Example: مدرسة لسان العرب">
              <input required name="site_name" className="field-input" placeholder="Exact place/site name" />
            </FormField>
            <FormField label="Site type" required hint="Choose the closest location type so Snacky saves a valid site record.">
              <select required name="location_type" className="field-input" defaultValue="other">
                {LOCATION_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Area" hint="General area only, not the exact site name.">
              <input name="area" className="field-input" placeholder="عين زارة" />
            </FormField>
            <FormField label="City">
              <input name="city" className="field-input" placeholder="Tripoli" />
            </FormField>
            <FormField label="Google Maps URL">
              <input name="google_maps_url" className="field-input" placeholder="https://maps.google.com/..." />
            </FormField>
            <FormField label="Contact person">
              <input name="contact_person_name" className="field-input" placeholder="Site contact name" />
            </FormField>
            <FormField label="Contact phone">
              <input name="contact_person_phone" className="field-input" placeholder="+218..." />
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
            <FormField label="Address">
              <textarea name="address_text" rows={4} className="field-input" placeholder="Street, building, parking, floor, or access notes" />
            </FormField>
            <FormField label="Notes">
              <textarea name="notes" rows={4} className="field-input" placeholder="Commercial notes, rent context, or machine placement notes" />
            </FormField>
            <FormField label="Latitude" hint="Optional for route distance and map linking later.">
              <input type="number" step="0.00000001" name="latitude" className="field-input" placeholder="32.8872" />
            </FormField>
            <FormField label="Longitude" hint="Optional for route distance and map linking later.">
              <input type="number" step="0.00000001" name="longitude" className="field-input" placeholder="13.1913" />
            </FormField>
          </div>
        </FormSection>
        <FormSection title="Payroll distance" description="Manual km entry is enough for now. Snacky will use this distance for completed stop pay calculations.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Storage location">
              <select name="payroll_storage_location_id" className="field-input" defaultValue="">
                <option value="">No storage selected</option>
                {((storageLocations ?? []) as StorageLocationRow[]).map((storageLocation) => (
                  <option key={storageLocation.id} value={storageLocation.id}>{storageLocation.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Distance from storage km">
              <input type="number" step="0.01" min="0" name="distance_from_storage_km" className="field-input" placeholder="12.5" />
            </FormField>
            <FormField label="Distance zone" required hint="Used by the current payroll engine before map routing is added.">
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
            <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 md:col-span-2">
              <input name="use_round_trip_distance" type="checkbox" value="yes" className="mt-1" />
              <span>
                <span className="block font-semibold text-slate-900">Use round trip distance</span>
                <span className="text-sm text-slate-500">If enabled, Snacky will multiply the one-way distance by 2 when payroll is calculated.</span>
              </span>
            </label>
            <FormField label="Payroll distance notes">
              <textarea name="payroll_distance_notes" rows={4} className="field-input" placeholder="Optional note about route direction or why this distance was chosen." />
            </FormField>
          </div>
        </FormSection>
        <div className="flex flex-col gap-3 sm:flex-row">
          <PrimaryButton>Add location</PrimaryButton>
          <SecondaryButton href="/locations">Cancel</SecondaryButton>
        </div>
      </LocalDraftForm>
    </FormPageLayout>
  );
}
