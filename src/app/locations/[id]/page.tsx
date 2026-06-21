import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { EmptyState, ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { buildLocationPayload, LOCATION_TYPE_OPTIONS, normalizeLocationType } from "@/lib/location-records";
import { formatSiteLabel } from "@/lib/machine-site-display";
import { locationPayrollDistanceKm } from "@/lib/payroll";

type LocationSearchParams = {
  success?: string;
  error?: string;
};

type LocationStorageRow = {
  id: string;
  name?: string | null;
};

type PayloadMode = "site" | "payroll" | "preflight";

type LocationRow = {
  id: string;
  name?: string | null;
  site_name?: string | null;
  area?: string | null;
  city?: string | null;
  address_text?: string | null;
  address?: string | null;
  google_maps_url?: string | null;
  contact_person_name?: string | null;
  contact_name?: string | null;
  contact_person_phone?: string | null;
  contact_phone?: string | null;
  source_location_lead_id?: string | null;
  location_type?: string | null;
  rent_amount?: number | string | null;
  status?: string | null;
  notes?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  distance_zone?: string | null;
  access_difficulty?: string | null;
  stop_multiplier?: number | string | null;
  payroll_storage_location_id?: string | null;
  distance_from_storage_km?: number | string | null;
  use_round_trip_distance?: boolean | null;
  payroll_distance_notes?: string | null;
  updated_at?: string | null;
};

type UpdatedLocationResult = Pick<LocationRow, "id" | "name" | "updated_at">;

const SITE_UPDATE_KEYS = [
  "name",
  "site_name",
  "area",
  "city",
  "address_text",
  "google_maps_url",
  "contact_person_name",
  "contact_person_phone",
  "source_location_lead_id",
  "address",
  "contact_name",
  "contact_phone",
  "location_type",
  "rent_amount",
  "status",
  "notes",
  "latitude",
  "longitude",
] as const;

const PAYROLL_UPDATE_KEYS = [
  "distance_zone",
  "access_difficulty",
  "stop_multiplier",
  "payroll_storage_location_id",
  "distance_from_storage_km",
  "use_round_trip_distance",
  "payroll_distance_notes",
] as const;

type RecoverableLocationUpdateResult<T> = {
  data: T | null;
  error: unknown;
  omittedColumns: string[];
  payloadKeys: string[];
  returnedRows: number;
};

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function rawText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = rawText(value).replace(/\s+/g, "");
  if (!text) return null;
  const normalized = text
    .replace(/٬/g, "")
    .replace(/٫/g, ".")
    .replace(/,/g, text.includes(".") ? "" : ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingColumnError(error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

function missingColumnName(error: { message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const text = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`;
  const standardMatch = text.match(/column ["']?([a-z0-9_]+)["']?/i);
  if (standardMatch?.[1]) return standardMatch[1];

  const postgrestMatch = text.match(/["']([a-z0-9_]+)["'] column/i);
  return postgrestMatch?.[1] ?? null;
}

function notice(message: string, tone: "success" | "error") {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-rose-200 bg-rose-50 text-rose-800";
  return <div className={`rounded-lg border px-4 py-3 text-sm font-medium ${styles}`}>{message}</div>;
}

function withMessage(pathname: string, key: "success" | "error", message: string) {
  const [basePath, existingQuery = ""] = pathname.split("?");
  const params = new URLSearchParams(existingQuery);
  params.set(key, message);
  return `${basePath}?${params.toString()}`;
}

function errorField(error: unknown, key: string) {
  if (!error || typeof error !== "object") return null;
  return (error as Record<string, unknown>)[key] ?? null;
}

function pickPayload<T extends Record<string, unknown>>(payload: T, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(payload, key))
      .map((key) => [key, payload[key as keyof T]]),
  ) as Record<string, unknown>;
}

async function updateLocationColumnsWithRecovery<T>({
  id,
  payload,
  select,
  supabase,
}: {
  id: string;
  payload: Record<string, unknown>;
  select: string;
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSupabaseServerClient>>>;
}): Promise<RecoverableLocationUpdateResult<T>> {
  const workingPayload = { ...payload };
  const omittedColumns: string[] = [];

  while (Object.keys(workingPayload).filter((key) => key !== "updated_at").length > 0) {
    const updateResult = await supabase
      .from("locations")
      .update(workingPayload)
      .eq("id", id)
      .select(select);

    const returnedRows = updateResult.data?.length ?? 0;
    if (!updateResult.error) {
      return {
        data: (updateResult.data?.[0] as T | undefined) ?? null,
        error: null,
        omittedColumns,
        payloadKeys: Object.keys(workingPayload),
        returnedRows,
      };
    }

    if (!isMissingColumnError(updateResult.error)) {
      return {
        data: null,
        error: updateResult.error,
        omittedColumns,
        payloadKeys: Object.keys(workingPayload),
        returnedRows,
      };
    }

    const column = missingColumnName(updateResult.error);
    if (!column || !Object.prototype.hasOwnProperty.call(workingPayload, column)) {
      return {
        data: null,
        error: updateResult.error,
        omittedColumns,
        payloadKeys: Object.keys(workingPayload),
        returnedRows,
      };
    }

    delete workingPayload[column];
    omittedColumns.push(column);
  }

  return {
    data: null,
    error: null,
    omittedColumns,
    payloadKeys: [],
    returnedRows: 0,
  };
}

function logLocationUpdateEvent({
  level,
  action,
  profile,
  locationId,
  table,
  payloadKeys,
  payloadMode,
  error,
  returnedRows,
  updatedRowId,
  revalidationPaths,
  redirectPath,
  extra,
}: {
  level: "info" | "error";
  action: string;
  profile: Awaited<ReturnType<typeof getCurrentProfile>> | null;
  locationId: string;
  table: string;
  payloadKeys: string[];
  payloadMode: PayloadMode;
  error?: unknown;
  returnedRows?: number | null;
  updatedRowId?: string | null;
  revalidationPaths: string[];
  redirectPath: string;
  extra?: Record<string, unknown>;
}) {
  const logger = level === "error" ? console.error : console.info;
  logger(`[locations] ${action}`, {
    current_user_id: profile?.id ?? null,
    current_user_role: profile?.role ?? null,
    current_user_roles: profile?.roles ?? [],
    current_team_member_id: profile?.team_member_id ?? null,
    submitted_location_id: locationId,
    table,
    update_payload_keys: payloadKeys,
    update_payload_mode: payloadMode,
    affected_or_returned_row_count: returnedRows ?? null,
    returned_updated_row_id: updatedRowId ?? null,
    supabase_error_code: errorField(error, "code"),
    supabase_error_message: errorField(error, "message"),
    supabase_error_details: errorField(error, "details"),
    supabase_error_hint: errorField(error, "hint"),
    revalidation_paths: revalidationPaths,
    redirect_path: redirectPath,
    ...(extra ?? {}),
  });
}

async function saveLocation(formData: FormData) {
  "use server";
  const profile = await getCurrentProfile();
  const rawId = String(formData.get("id") || "").trim();
  const listPath = "/locations";
  const detailPath = rawId ? `/locations/${rawId}` : listPath;
  if (!profile) redirect("/unauthorized");
  if (!hasPermission(profile, "machines.manage")) {
    redirect(withMessage(detailPath, "error", "Could not update location. You do not have permission."));
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    redirect(withMessage(detailPath, "error", "Could not update location. Supabase is not configured."));
  }

  const id = rawId;
  if (!id) redirect(withMessage(listPath, "error", "Could not update location. A valid location id is required."));

  const siteName = String(formData.get("site_name") || "").trim();
  if (!siteName) redirect(withMessage(detailPath, "error", "Could not update location. Exact site name is required."));

  const rentAmountInput = rawText(formData.get("rent_amount"));
  const stopMultiplierInput = rawText(formData.get("stop_multiplier"));
  const latitudeInput = rawText(formData.get("latitude"));
  const longitudeInput = rawText(formData.get("longitude"));
  const distanceFromStorageInput = rawText(formData.get("distance_from_storage_km"));

  const rentAmount = optionalNumber(formData.get("rent_amount"));
  const stopMultiplier = optionalNumber(formData.get("stop_multiplier"));
  const latitude = optionalNumber(formData.get("latitude"));
  const longitude = optionalNumber(formData.get("longitude"));
  const distanceFromStorageKm = optionalNumber(formData.get("distance_from_storage_km"));

  if (rentAmountInput && rentAmount === null) {
    redirect(withMessage(detailPath, "error", "Could not update location. Enter a valid rent amount."));
  }

  if (stopMultiplierInput && (stopMultiplier === null || stopMultiplier <= 0)) {
    redirect(withMessage(detailPath, "error", "Could not update location. Stop multiplier must be greater than zero."));
  }

  if (latitudeInput && latitude === null) {
    redirect(withMessage(detailPath, "error", "Could not update location. Enter a valid latitude."));
  }

  if (longitudeInput && longitude === null) {
    redirect(withMessage(detailPath, "error", "Could not update location. Enter a valid longitude."));
  }

  if (distanceFromStorageInput && (distanceFromStorageKm === null || distanceFromStorageKm < 0)) {
    redirect(withMessage(detailPath, "error", "Could not update location. Enter a valid non-negative payroll distance."));
  }

  const draft = {
    site_name: siteName,
    area: cleanText(formData.get("area")),
    city: cleanText(formData.get("city")),
    address_text: cleanText(formData.get("address_text")),
    google_maps_url: cleanText(formData.get("google_maps_url")),
    contact_person_name: cleanText(formData.get("contact_person_name")),
    contact_person_phone: cleanText(formData.get("contact_person_phone")),
    source_location_lead_id: cleanText(formData.get("source_location_lead_id")),
    location_type: normalizeLocationType(formData.get("location_type")),
    rent_amount: rentAmount ?? 0,
    status: String(formData.get("status") || "active"),
    notes: cleanText(formData.get("notes")),
    latitude,
    longitude,
    distance_zone: String(formData.get("distance_zone") || "within_10_km"),
    access_difficulty: String(formData.get("access_difficulty") || "normal"),
    stop_multiplier: stopMultiplier ?? 1,
    payroll_storage_location_id: cleanText(formData.get("payroll_storage_location_id")),
    distance_from_storage_km: distanceFromStorageKm,
    use_round_trip_distance: String(formData.get("use_round_trip_distance") || "") === "yes",
    payroll_distance_notes: cleanText(formData.get("payroll_distance_notes")),
  };
  const now = new Date().toISOString();
  const revalidationPaths = ["/locations", `/locations/${id}`, "/payroll", "/payroll/periods"];

  const existingLocationResult = await supabase.from("locations").select("id").eq("id", id).maybeSingle();
  if (existingLocationResult.error) {
    logLocationUpdateEvent({
      level: "error",
      action: "Failed to load location before update",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: [],
      payloadMode: "preflight",
      error: existingLocationResult.error,
      returnedRows: 0,
      updatedRowId: null,
      revalidationPaths,
      redirectPath: detailPath,
    });
    redirect(withMessage(detailPath, "error", "Could not update location. The location could not be loaded first."));
  }

  if (!existingLocationResult.data) {
    logLocationUpdateEvent({
      level: "error",
      action: "Location missing before update",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: [],
      payloadMode: "preflight",
      returnedRows: 0,
      updatedRowId: null,
      revalidationPaths,
      redirectPath: listPath,
    });
    redirect(withMessage(listPath, "error", "Could not update location. The location may not exist or you may not have permission."));
  }

  const fullPayload = buildLocationPayload(draft);
  const siteUpdateResult = await updateLocationColumnsWithRecovery<UpdatedLocationResult>({
    id,
    payload: { ...pickPayload(fullPayload, SITE_UPDATE_KEYS), updated_at: now },
    select: "id, name, updated_at",
    supabase,
  });

  if (siteUpdateResult.error) {
    logLocationUpdateEvent({
      level: "error",
      action: "Location site update failed",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: siteUpdateResult.payloadKeys,
      payloadMode: "site",
      error: siteUpdateResult.error,
      returnedRows: siteUpdateResult.returnedRows,
      updatedRowId: null,
      revalidationPaths,
      redirectPath: detailPath,
      extra: {
        omitted_columns: siteUpdateResult.omittedColumns,
      },
    });
    redirect(withMessage(detailPath, "error", "Could not update location. Please try again."));
  }

  const updatedLocation = siteUpdateResult.data;
  if (!updatedLocation) {
    logLocationUpdateEvent({
      level: "error",
      action: "Location site update returned zero rows",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: siteUpdateResult.payloadKeys,
      payloadMode: "site",
      error: siteUpdateResult.error,
      returnedRows: siteUpdateResult.returnedRows,
      updatedRowId: null,
      revalidationPaths,
      redirectPath: detailPath,
      extra: {
        zero_rows_reason: "No updated row was returned from Supabase. The location may not exist or update permission may be blocked.",
        omitted_columns: siteUpdateResult.omittedColumns,
      },
    });
    redirect(withMessage(detailPath, "error", "Could not update location. The location may not exist or you may not have permission."));
  }

  const payrollUpdateResult = await updateLocationColumnsWithRecovery<LocationRow>({
    id,
    payload: { ...pickPayload(fullPayload, PAYROLL_UPDATE_KEYS), updated_at: now },
    select: "id, payroll_storage_location_id, distance_from_storage_km, use_round_trip_distance, payroll_distance_notes, distance_zone, access_difficulty, stop_multiplier, updated_at",
    supabase,
  });

  if (payrollUpdateResult.error || !payrollUpdateResult.data) {
    revalidationPaths.forEach((path) => revalidatePath(path));
    logLocationUpdateEvent({
      level: "error",
      action: "Location payroll settings update failed after site save",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: payrollUpdateResult.payloadKeys,
      payloadMode: "payroll",
      error: payrollUpdateResult.error,
      returnedRows: payrollUpdateResult.returnedRows,
      updatedRowId: updatedLocation.id,
      revalidationPaths,
      redirectPath: detailPath,
      extra: {
        site_update_completed: true,
        omitted_columns: payrollUpdateResult.omittedColumns,
      },
    });
    redirect(withMessage(detailPath, "error", "Location name saved, but payroll distance could not be saved."));
  }

  if (payrollUpdateResult.omittedColumns.length) {
    revalidationPaths.forEach((path) => revalidatePath(path));
    logLocationUpdateEvent({
      level: "error",
      action: "Location payroll settings partially saved",
      profile,
      locationId: id,
      table: "locations",
      payloadKeys: payrollUpdateResult.payloadKeys,
      payloadMode: "payroll",
      returnedRows: payrollUpdateResult.returnedRows,
      updatedRowId: updatedLocation.id,
      revalidationPaths,
      redirectPath: detailPath,
      extra: {
        site_update_completed: true,
        omitted_columns: payrollUpdateResult.omittedColumns,
      },
    });
    redirect(withMessage(detailPath, "error", "Location name saved, but some payroll distance fields are not available in this database yet."));
  }

  revalidationPaths.forEach((path) => revalidatePath(path));
  logLocationUpdateEvent({
    level: "info",
    action: "Location updated successfully",
    profile,
    locationId: id,
    table: "locations",
    payloadKeys: [...siteUpdateResult.payloadKeys, ...payrollUpdateResult.payloadKeys],
    payloadMode: "site",
    returnedRows: 1,
    updatedRowId: updatedLocation.id,
    revalidationPaths,
    redirectPath: detailPath,
    extra: {
      updated_site_name: draft.site_name ?? updatedLocation.name ?? null,
      updated_area: draft.area ?? null,
      updated_city: draft.city ?? null,
      updated_name_column: updatedLocation.name ?? null,
      payroll_storage_location_id: payrollUpdateResult.data.payroll_storage_location_id ?? null,
      distance_from_storage_km: payrollUpdateResult.data.distance_from_storage_km ?? null,
      use_round_trip_distance: payrollUpdateResult.data.use_round_trip_distance ?? null,
    },
  });
  redirect(withMessage(detailPath, "success", "Location updated successfully."));
}

export default async function EditLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<LocationSearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const [{ data: location, error: locationError }, { data: storageLocations }] = supabase
    ? await Promise.all([
        supabase.from("locations").select("*").eq("id", id).maybeSingle(),
        supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
      ])
    : [{ data: null, error: null }, { data: [] }];

  if (locationError) {
    console.error("[locations] Failed to load location edit page", {
      table: "locations",
      location_id: id,
      supabase_error_code: errorField(locationError, "code"),
      supabase_error_message: errorField(locationError, "message"),
      supabase_error_details: errorField(locationError, "details"),
      supabase_error_hint: errorField(locationError, "hint"),
    });
    return (
      <ErrorState
        title="Could not load location"
        body="Snacky OS could not load this location record right now."
        action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
      />
    );
  }

  if (!location) {
    return (
      <EmptyState
        title="Location not found"
        body="This location may have been removed or you may not have access to it."
        action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
      />
    );
  }

  const payrollDistanceKm = locationPayrollDistanceKm(location);
  const activeSiteLabel = formatSiteLabel(location, { includeArea: true, fallback: "Unknown site" });

  return (
    <FormPageLayout>
      <PageHeader
        title={`Edit site: ${activeSiteLabel}`}
        subtitle="Keep the exact site, broader area, and payroll distance clear without tying the physical machine identity to this record."
        breadcrumbs={[{ label: "Machines", href: "/machines" }, { label: "Locations", href: "/locations" }, { label: activeSiteLabel }]}
        action={<SecondaryButton href="/locations">Back to locations</SecondaryButton>}
      />
      <div className="space-y-4">
        {query.success ? notice(String(query.success), "success") : null}
        {query.error ? notice(String(query.error), "error") : null}
      </div>
      <LocalDraftForm action={saveLocation} formType="location" draftKeyParts={[location.id]} className="space-y-5">
        <input type="hidden" name="id" value={location.id} />
        <input type="hidden" name="source_location_lead_id" value={location.source_location_lead_id ?? ""} />
        <FormSection title="Site details" description="Use the exact site name here, and keep area as the broader neighborhood or district only.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Exact site name" required>
              <input required name="site_name" defaultValue={location.site_name ?? location.name} className="field-input" />
            </FormField>
            <FormField label="Site type" required>
              <select required name="location_type" defaultValue={normalizeLocationType(location.location_type)} className="field-input">
                {LOCATION_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Area">
              <input name="area" defaultValue={location.area ?? ""} className="field-input" placeholder="عين زارة" />
            </FormField>
            <FormField label="City">
              <input name="city" defaultValue={location.city ?? ""} className="field-input" placeholder="Tripoli" />
            </FormField>
            <FormField label="Google Maps URL">
              <input name="google_maps_url" defaultValue={location.google_maps_url ?? ""} className="field-input" placeholder="https://maps.google.com/..." />
            </FormField>
            <FormField label="Contact person">
              <input name="contact_person_name" defaultValue={location.contact_person_name ?? location.contact_name ?? ""} className="field-input" />
            </FormField>
            <FormField label="Contact phone">
              <input name="contact_person_phone" defaultValue={location.contact_person_phone ?? location.contact_phone ?? ""} className="field-input" />
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
            <FormField label="Address">
              <textarea name="address_text" rows={4} defaultValue={location.address_text ?? location.address ?? ""} className="field-input" placeholder="Street, building, floor, parking, or landlord notes" />
            </FormField>
            <FormField label="Notes">
              <textarea name="notes" rows={4} defaultValue={location.notes ?? ""} className="field-input" placeholder="Commercial notes, access details, or machine placement context" />
            </FormField>
            <FormField label="Latitude">
              <input type="number" step="0.00000001" name="latitude" defaultValue={location.latitude ?? ""} className="field-input" />
            </FormField>
            <FormField label="Longitude">
              <input type="number" step="0.00000001" name="longitude" defaultValue={location.longitude ?? ""} className="field-input" />
            </FormField>
          </div>
        </FormSection>
        <FormSection title="Payroll distance" description="Manual km entry is enough for now. Snacky uses this value for completed stop distance pay and fuel allowance.">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Storage location">
              <select name="payroll_storage_location_id" defaultValue={location.payroll_storage_location_id ?? ""} className="field-input">
                <option value="">No storage selected</option>
                {((storageLocations ?? []) as LocationStorageRow[]).map((storageLocation) => (
                  <option key={storageLocation.id} value={storageLocation.id}>{storageLocation.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Distance from storage km">
              <input type="number" step="0.01" min="0" name="distance_from_storage_km" defaultValue={location.distance_from_storage_km ?? ""} className="field-input" />
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
  );
}
