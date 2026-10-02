export type LocationSiteDraft = {
  site_name: string;
  area: string | null;
  city: string | null;
  address_text: string | null;
  google_maps_url: string | null;
  contact_person_name: string | null;
  contact_person_phone: string | null;
  source_location_lead_id?: string | null;
  location_type: string;
  rent_amount: number;
  status: string;
  notes: string | null;
  latitude?: number | null;
  longitude?: number | null;
  distance_zone?: string;
  access_difficulty?: string;
  stop_multiplier?: number;
  payroll_storage_location_id?: string | null;
  distance_from_storage_km?: number | null;
  use_round_trip_distance?: boolean;
  payroll_distance_notes?: string | null;
};

export const LOCATION_TYPE_OPTIONS = [
  "school",
  "hospital",
  "mall",
  "university",
  "office",
  "gym",
  "warehouse",
  "mixed",
  "other",
] as const;

const LOCATION_TYPE_ALIASES: Record<string, (typeof LOCATION_TYPE_OPTIONS)[number]> = {
  school: "school",
  schools: "school",
  hospital: "hospital",
  hospitals: "hospital",
  mall: "mall",
  malls: "mall",
  university: "university",
  universities: "university",
  college: "university",
  campus: "university",
  office: "office",
  offices: "office",
  company: "office",
  business: "office",
  gym: "gym",
  gyms: "gym",
  fitness: "gym",
  warehouse: "warehouse",
  storage: "warehouse",
  mixed: "mixed",
  multi: "mixed",
  other: "other",
};

export function normalizeLocationType(value: FormDataEntryValue | string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) return "other";
  return LOCATION_TYPE_ALIASES[normalized] ?? "other";
}

export function buildLocationName(siteName: string, area: string | null) {
  const cleanSiteName = siteName.trim();
  if (cleanSiteName) return cleanSiteName;
  const cleanArea = String(area ?? "").trim();
  return cleanArea || "Unnamed location";
}

export function buildLocationPayload(draft: LocationSiteDraft) {
  return {
    name: buildLocationName(draft.site_name, draft.area),
    site_name: draft.site_name.trim() || null,
    area: draft.area,
    city: draft.city,
    address_text: draft.address_text,
    google_maps_url: draft.google_maps_url,
    contact_person_name: draft.contact_person_name,
    contact_person_phone: draft.contact_person_phone,
    source_location_lead_id: draft.source_location_lead_id ?? null,
    address: draft.address_text,
    contact_name: draft.contact_person_name,
    contact_phone: draft.contact_person_phone,
    location_type: draft.location_type,
    rent_amount: draft.rent_amount,
    status: draft.status,
    notes: draft.notes,
    latitude: draft.latitude ?? null,
    longitude: draft.longitude ?? null,
    distance_zone: draft.distance_zone ?? "within_10_km",
    access_difficulty: draft.access_difficulty ?? "normal",
    stop_multiplier: draft.stop_multiplier ?? 1,
    payroll_storage_location_id: draft.payroll_storage_location_id ?? null,
    distance_from_storage_km: draft.distance_from_storage_km ?? null,
    use_round_trip_distance: Boolean(draft.use_round_trip_distance),
    payroll_distance_notes: draft.payroll_distance_notes ?? null,
  };
}

export function buildLocationLegacyPayload(draft: LocationSiteDraft) {
  return {
    name: buildLocationName(draft.site_name, draft.area),
    address: draft.address_text,
    contact_name: draft.contact_person_name,
    contact_phone: draft.contact_person_phone,
    location_type: draft.location_type,
    rent_amount: draft.rent_amount,
    status: draft.status,
    notes: draft.notes,
    latitude: draft.latitude ?? null,
    longitude: draft.longitude ?? null,
    distance_zone: draft.distance_zone ?? "within_10_km",
    access_difficulty: draft.access_difficulty ?? "normal",
    stop_multiplier: draft.stop_multiplier ?? 1,
    payroll_storage_location_id: draft.payroll_storage_location_id ?? null,
    distance_from_storage_km: draft.distance_from_storage_km ?? null,
    use_round_trip_distance: Boolean(draft.use_round_trip_distance),
    payroll_distance_notes: draft.payroll_distance_notes ?? null,
  };
}

export function buildLocationMinimalPayload(draft: LocationSiteDraft) {
  return {
    name: buildLocationName(draft.site_name, draft.area),
    address: draft.address_text,
    contact_name: draft.contact_person_name,
    contact_phone: draft.contact_person_phone,
    location_type: draft.location_type,
    rent_amount: draft.rent_amount,
    status: draft.status,
    notes: draft.notes,
    latitude: draft.latitude ?? null,
    longitude: draft.longitude ?? null,
  };
}
