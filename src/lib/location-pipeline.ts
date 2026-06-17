export const locationPipelinePlaceTypes = ["school", "hospital", "university", "office", "mall", "gym", "other"] as const;
export type LocationPipelinePlaceType = (typeof locationPipelinePlaceTypes)[number];

export const locationPipelineStatuses = [
  "want_to_contact",
  "contacted",
  "interested",
  "meeting_needed",
  "offer_sent",
  "accepted",
  "rejected",
  "follow_up_later",
  "machine_placed",
] as const;
export type LocationPipelineStatus = (typeof locationPipelineStatuses)[number];

export type LocationPipelineLeadRow = {
  id: string;
  place_name: string;
  place_type: string | null;
  city: string | null;
  area: string | null;
  address_text: string | null;
  google_maps_url: string | null;
  contact_person_name: string | null;
  contact_person_job_title: string | null;
  contact_phone: string | null;
  contact_whatsapp: string | null;
  contacted_by_user_id: string | null;
  first_contact_date: string | null;
  last_contact_date: string | null;
  next_follow_up_date: string | null;
  status: string | null;
  notes: string | null;
  estimated_traffic: number | string | null;
  rent_expectation: number | string | null;
  rejection_reason: string | null;
  converted_location_id: string | null;
  converted_at: string | null;
  is_archived: boolean | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

const placeTypeLabels: Record<LocationPipelinePlaceType, string> = {
  school: "School",
  hospital: "Hospital",
  university: "University",
  office: "Office",
  mall: "Mall",
  gym: "Gym",
  other: "Other",
};

const statusLabels: Record<LocationPipelineStatus, string> = {
  want_to_contact: "Want to contact",
  contacted: "Contacted",
  interested: "Interested",
  meeting_needed: "Meeting needed",
  offer_sent: "Offer sent",
  accepted: "Accepted",
  rejected: "Rejected",
  follow_up_later: "Follow up later",
  machine_placed: "Machine placed",
};

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

export function isLocationPipelinePlaceType(value: string | null | undefined): value is LocationPipelinePlaceType {
  return locationPipelinePlaceTypes.includes(String(value ?? "") as LocationPipelinePlaceType);
}

export function isLocationPipelineStatus(value: string | null | undefined): value is LocationPipelineStatus {
  return locationPipelineStatuses.includes(String(value ?? "") as LocationPipelineStatus);
}

export function normalizeLocationPipelinePlaceType(value: string | null | undefined, fallback: LocationPipelinePlaceType = "other"): LocationPipelinePlaceType {
  return isLocationPipelinePlaceType(value) ? value : fallback;
}

export function normalizeLocationPipelineStatus(value: string | null | undefined, fallback: LocationPipelineStatus = "want_to_contact"): LocationPipelineStatus {
  return isLocationPipelineStatus(value) ? value : fallback;
}

export function locationPipelinePlaceTypeLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelinePlaceType(value);
  return placeTypeLabels[normalized] ?? titleCase(normalized);
}

export function locationPipelineStatusLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelineStatus(value);
  return statusLabels[normalized] ?? titleCase(normalized);
}

export function buildLocationPipelineAddressSummary(lead: Pick<LocationPipelineLeadRow, "city" | "area" | "address_text">) {
  const parts = [lead.city, lead.area, lead.address_text]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" - ") : null;
}

export function buildLocationPipelineNotesForLocation(lead: Pick<LocationPipelineLeadRow, "notes" | "google_maps_url" | "contact_whatsapp" | "rejection_reason" | "city" | "area">) {
  const lines = [
    lead.city || lead.area ? `Pipeline area: ${[lead.city, lead.area].filter(Boolean).join(" / ")}` : "",
    lead.google_maps_url ? `Maps: ${lead.google_maps_url}` : "",
    lead.contact_whatsapp ? `WhatsApp: ${lead.contact_whatsapp}` : "",
    lead.rejection_reason ? `Previous rejection note: ${lead.rejection_reason}` : "",
    lead.notes ? `Pipeline notes: ${lead.notes}` : "",
  ]
    .map((value) => String(value).trim())
    .filter(Boolean);

  return lines.length ? lines.join("\n") : null;
}
