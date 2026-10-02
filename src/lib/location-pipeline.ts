export const locationPipelinePlaceTypes = ["school", "hospital", "university", "office", "mall", "gym", "other"] as const;
export type LocationPipelinePlaceType = (typeof locationPipelinePlaceTypes)[number];

export const locationPipelineStatuses = [
  "want_to_contact",
  "contacted",
  "interested",
  "meeting_needed",
  "visit_scheduled",
  "visited",
  "offer_sent",
  "negotiating",
  "trial_contract",
  "accepted",
  "rejected",
  "follow_up_later",
  "machine_placed",
] as const;
export type LocationPipelineStatus = (typeof locationPipelineStatuses)[number];

export const locationPipelineSources = [
  "manual",
  "owner",
  "customer_support",
  "field_outreach",
  "inbound",
  "referral",
  "archive_import",
  "other",
] as const;
export type LocationPipelineSource = (typeof locationPipelineSources)[number];

export const locationPipelinePriorities = ["low", "normal", "high", "urgent"] as const;
export type LocationPipelinePriority = (typeof locationPipelinePriorities)[number];

export const locationPipelineActivityTypes = ["call", "whatsapp", "visit", "meeting", "proposal", "email", "note", "status_change", "other"] as const;
export type LocationPipelineActivityType = (typeof locationPipelineActivityTypes)[number];

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
  assigned_to_user_id: string | null;
  first_contact_date: string | null;
  last_contact_date: string | null;
  next_follow_up_date: string | null;
  next_action: string | null;
  next_action_date: string | null;
  last_activity_at: string | null;
  source: string | null;
  priority: string | null;
  imported_source: string | null;
  imported_category: string | null;
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

export type LocationPipelineActivityRow = {
  id: string;
  lead_id: string;
  activity_type: string;
  summary: string;
  outcome: string | null;
  occurred_at: string;
  next_action: string | null;
  next_action_date: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

const placeTypeLabels: Record<LocationPipelinePlaceType, string> = {
  school: "School",
  hospital: "Hospital / clinic",
  university: "University / institute",
  office: "Company / office",
  mall: "Mall",
  gym: "Gym",
  other: "Other",
};

const statusLabels: Record<LocationPipelineStatus, string> = {
  want_to_contact: "New lead",
  contacted: "Contacted",
  interested: "Interested / qualified",
  meeting_needed: "Meeting needed",
  visit_scheduled: "Visit scheduled",
  visited: "Visited",
  offer_sent: "Proposal sent",
  negotiating: "Negotiating",
  trial_contract: "Trial / contract",
  accepted: "Won / accepted",
  rejected: "Lost / rejected",
  follow_up_later: "Follow up later",
  machine_placed: "Machine placed",
};

const sourceLabels: Record<LocationPipelineSource, string> = {
  manual: "Manual",
  owner: "Owner",
  customer_support: "Customer support",
  field_outreach: "Field outreach",
  inbound: "Inbound inquiry",
  referral: "Referral",
  archive_import: "Archive import",
  other: "Other",
};

const priorityLabels: Record<LocationPipelinePriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const activityLabels: Record<LocationPipelineActivityType, string> = {
  call: "Call",
  whatsapp: "WhatsApp",
  visit: "Visit",
  meeting: "Meeting",
  proposal: "Proposal",
  email: "Email",
  note: "Note",
  status_change: "Status change",
  other: "Other",
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

export function isLocationPipelineSource(value: string | null | undefined): value is LocationPipelineSource {
  return locationPipelineSources.includes(String(value ?? "") as LocationPipelineSource);
}

export function isLocationPipelinePriority(value: string | null | undefined): value is LocationPipelinePriority {
  return locationPipelinePriorities.includes(String(value ?? "") as LocationPipelinePriority);
}

export function isLocationPipelineActivityType(value: string | null | undefined): value is LocationPipelineActivityType {
  return locationPipelineActivityTypes.includes(String(value ?? "") as LocationPipelineActivityType);
}

export function normalizeLocationPipelinePlaceType(value: string | null | undefined, fallback: LocationPipelinePlaceType = "other"): LocationPipelinePlaceType {
  return isLocationPipelinePlaceType(value) ? value : fallback;
}

export function normalizeLocationPipelineStatus(value: string | null | undefined, fallback: LocationPipelineStatus = "want_to_contact"): LocationPipelineStatus {
  return isLocationPipelineStatus(value) ? value : fallback;
}

export function normalizeLocationPipelineSource(value: string | null | undefined, fallback: LocationPipelineSource = "manual"): LocationPipelineSource {
  return isLocationPipelineSource(value) ? value : fallback;
}

export function normalizeLocationPipelinePriority(value: string | null | undefined, fallback: LocationPipelinePriority = "normal"): LocationPipelinePriority {
  return isLocationPipelinePriority(value) ? value : fallback;
}

export function normalizeLocationPipelineActivityType(value: string | null | undefined, fallback: LocationPipelineActivityType = "note"): LocationPipelineActivityType {
  return isLocationPipelineActivityType(value) ? value : fallback;
}

export function locationPipelinePlaceTypeLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelinePlaceType(value);
  return placeTypeLabels[normalized] ?? titleCase(normalized);
}

export function locationPipelineStatusLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelineStatus(value);
  return statusLabels[normalized] ?? titleCase(normalized);
}

export function locationPipelineSourceLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelineSource(value);
  return sourceLabels[normalized] ?? titleCase(normalized);
}

export function locationPipelinePriorityLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelinePriority(value);
  return priorityLabels[normalized] ?? titleCase(normalized);
}

export function locationPipelineActivityTypeLabel(value: string | null | undefined) {
  const normalized = normalizeLocationPipelineActivityType(value);
  return activityLabels[normalized] ?? titleCase(normalized);
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
