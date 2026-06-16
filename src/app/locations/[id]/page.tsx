import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { EmptyState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { locationPayrollDistanceKm } from "@/lib/payroll";

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
    payroll_storage_location_id: String(formData.get("payroll_storage_location_id") || "").trim() || null,
    distance_from_storage_km: optionalNumber(formData.get("distance_from_storage_km")),
    use_round_trip_distance: String(formData.get("use_round_trip_distance") || "") === "yes",
    payroll_distance_notes: String(formData.get("payroll_distance_notes") || "").trim() || null,
  };
  let updateResult = await supabase
    .from("locations")
    .update(payload)
    .eq("id", id);
  if (updateResult.error) {
    const errorText = [updateResult.error.code, updateResult.error.message, updateResult.error.details].map((value) => String(value ?? "")).join(" ").toLowerCase();
    if (errorText.includes("column") && errorText.includes("does not exist")) {
      console.warn("[locations] Retrying save without payroll distance columns", { locationId: id, error: updateResult.error });
      updateResult = await supabase
        .from("locations")
        .update({
          name: payload.name,
          location_type: payload.location_type,
          rent_amount: payload.rent_amount,
          status: payload.status,
          latitude: payload.latitude,
          longitude: payload.longitude,
          distance_zone: payload.distance_zone,
          access_difficulty: payload.access_difficulty,
          stop_multiplier: payload.stop_multiplier,
        })
        .eq("id", id);
    }
  }
  if (updateResult.error) {
    console.error("[locations] Failed to save location", { locationId: id, error: updateResult.error, payload });
  }
  revalidatePath("/locations");
  revalidatePath(`/locations/${id}`);
  revalidatePath("/payroll");
  revalidatePath("/payroll/periods");
  redirect("/locations");
}

export default async function EditLocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const [{ data: location }, { data: storageLocations }] = supabase
    ? await Promise.all([
        supabase.from("locations").select("*").eq("id", id).maybeSingle(),
        supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
      ])
    : [{ data: null }, { data: [] }];

  if (!location) {
    return (
      <>
        <EmptyState title="Location not found" body="This location may have been removed or you may not have access to it." action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>} />
      </>
    );
  }

  const payrollDistanceKm = locationPayrollDistanceKm(location);

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={`Edit location: ${location.name}`}
          subtitle="Update site classification, rent, and the payroll distance used when completed route stops are paid."
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
          <FormSection title="Payroll distance" description="Manual km entry is enough for now. Snacky uses this value for completed stop distance pay and fuel allowance.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Storage location">
                <select name="payroll_storage_location_id" defaultValue={location.payroll_storage_location_id ?? ""} className="field-input">
                  <option value="">No storage selected</option>
                  {(storageLocations ?? []).map((storageLocation: any) => (
                    <option key={storageLocation.id} value={storageLocation.id}>{storageLocation.name}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Distance from storage km">
                <input type="number" step="0.01" min="0" name="distance_from_storage_km" defaultValue={location.distance_from_storage_km ?? ""} className="field-input" />
              </FormField>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 md:col-span-2">
                <input name="use_round_trip_distance" type="checkbox" value="yes" defaultChecked={Boolean(location.use_round_trip_distance)} className="mt-1" />
                <span>
                  <span className="block font-semibold text-slate-900">Use round trip distance</span>
                  <span className="text-sm text-slate-500">If enabled, Snacky will multiply the one-way distance by 2 for payroll.</span>
                </span>
              </label>
              <FormField label="Calculated payroll distance km">
                <input value={payrollDistanceKm === null ? "Missing distance" : `${payrollDistanceKm.toFixed(2)} km`} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="Payroll distance notes">
                <textarea name="payroll_distance_notes" rows={4} defaultValue={location.payroll_distance_notes ?? ""} className="field-input" placeholder="Optional note about route direction, storage source, or why this distance was chosen." />
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
