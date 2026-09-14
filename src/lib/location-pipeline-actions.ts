import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  LocationPipelineLeadRow,
  buildLocationPipelineAddressSummary,
  buildLocationPipelineNotesForLocation,
  normalizeLocationPipelineActivityType,
  normalizeLocationPipelinePlaceType,
  normalizeLocationPipelinePriority,
  normalizeLocationPipelineSource,
  normalizeLocationPipelineStatus,
} from "@/lib/location-pipeline";
import { buildLocationLegacyPayload, buildLocationMinimalPayload, buildLocationPayload } from "@/lib/location-records";
import { logLocationPipelineError, requireLocationPipelineAccess } from "@/lib/location-pipeline-server";

function optionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${text}`);
  return parsed;
}

function optionalInteger(value: FormDataEntryValue | null) {
  const parsed = optionalNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed);
}

function optionalDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid date: ${text}`);
  return text;
}

function optionalDateTime(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date/time: ${text}`);
  return parsed.toISOString();
}

function isMissingColumnError(error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null | undefined) {
  const message = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return error?.code === "42703" || error?.code === "PGRST204" || (message.includes("column") && message.includes("does not exist"));
}

function withMessage(pathname: string, key: "success" | "error", message: string) {
  const [basePath, existingQuery = ""] = pathname.split("?");
  const params = new URLSearchParams(existingQuery);
  params.set(key, message);
  return `${basePath}?${params.toString()}`;
}

function fail(pathname: string, message: string): never {
  redirect(withMessage(pathname, "error", message));
}

function success(pathname: string, message: string): never {
  redirect(withMessage(pathname, "success", message));
}

function safeReturnPath(value: string | null | undefined, fallback: string) {
  const path = String(value ?? "").trim();
  if (!path.startsWith("/")) return fallback;
  if (path.startsWith("/locations-pipeline") || path === "/locations" || path.startsWith("/locations/")) return path;
  return fallback;
}

function revalidateLocationPipeline(id?: string | null) {
  revalidatePath("/locations-pipeline");
  revalidatePath("/locations-pipeline/new");
  if (id) revalidatePath(`/locations-pipeline/${id}`);
  revalidatePath("/locations");
}

function parseLeadValues(formData: FormData, defaultContactUserId?: string | null) {
  const placeName = String(formData.get("place_name") || "").trim();
  if (!placeName) throw new Error("Place name is required.");

  const placeType = normalizeLocationPipelinePlaceType(String(formData.get("place_type") || "other"));
  const status = normalizeLocationPipelineStatus(String(formData.get("status") || "want_to_contact"));
  const source = normalizeLocationPipelineSource(String(formData.get("source") || "manual"));
  const priority = normalizeLocationPipelinePriority(String(formData.get("priority") || "normal"));
  const estimatedTraffic = optionalInteger(formData.get("estimated_traffic"));
  const rentExpectation = optionalNumber(formData.get("rent_expectation"));
  const nextActionDate = optionalDate(formData.get("next_action_date"));

  if (estimatedTraffic !== null && estimatedTraffic < 0) throw new Error("Estimated traffic cannot be negative.");
  if (rentExpectation !== null && rentExpectation < 0) throw new Error("Rent expectation cannot be negative.");

  return {
    place_name: placeName,
    place_type: placeType,
    city: optionalText(formData.get("city")),
    area: optionalText(formData.get("area")),
    address_text: optionalText(formData.get("address_text")),
    google_maps_url: optionalText(formData.get("google_maps_url")),
    contact_person_name: optionalText(formData.get("contact_person_name")),
    contact_person_job_title: optionalText(formData.get("contact_person_job_title")),
    contact_phone: optionalText(formData.get("contact_phone")),
    contact_whatsapp: optionalText(formData.get("contact_whatsapp")),
    contacted_by_user_id: optionalText(formData.get("contacted_by_user_id")) ?? defaultContactUserId ?? null,
    assigned_to_user_id: optionalText(formData.get("assigned_to_user_id")),
    first_contact_date: optionalDate(formData.get("first_contact_date")),
    last_contact_date: optionalDate(formData.get("last_contact_date")),
    next_follow_up_date: nextActionDate ?? optionalDate(formData.get("next_follow_up_date")),
    next_action: optionalText(formData.get("next_action")),
    next_action_date: nextActionDate,
    source,
    priority,
    status,
    notes: optionalText(formData.get("notes")),
    estimated_traffic: estimatedTraffic,
    rent_expectation: rentExpectation,
    rejection_reason: optionalText(formData.get("rejection_reason")),
  };
}

export async function createLocationPipelineLead(formData: FormData) {
  "use server";
  const returnPath = "/locations-pipeline/new";
  const { profile, supabase } = await requireLocationPipelineAccess(returnPath);

  let payload: ReturnType<typeof parseLeadValues>;
  try {
    payload = parseLeadValues(formData, profile.team_member_id);
  } catch (error) {
    fail(returnPath, error instanceof Error ? error.message : "Could not read this lead.");
  }

  if (payload.status === "machine_placed") {
    fail(returnPath, "Use the convert action after acceptance instead of creating a lead as machine placed.");
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("location_pipeline_leads")
    .insert({ ...payload, last_activity_at: now, created_at: now, updated_at: now })
    .select("id")
    .single();

  if (error || !data?.id) {
    logLocationPipelineError({
      action: "Failed to create lead",
      table: "location_pipeline_leads",
      profile,
      error,
      extra: { insert_payload: payload },
    });
    fail(returnPath, "Could not create this location lead.");
  }

  const initialSummary = payload.first_contact_date || payload.status !== "want_to_contact"
    ? "Lead added with existing contact history."
    : "Lead added to Snacky CRM.";
  const activityResult = await supabase.from("location_pipeline_activities").insert({
    lead_id: data.id,
    activity_type: "note",
    summary: initialSummary,
    next_action: payload.next_action,
    next_action_date: payload.next_action_date,
    created_by_user_id: profile.team_member_id ?? null,
    occurred_at: now,
    created_at: now,
  });
  if (activityResult.error) {
    logLocationPipelineError({ action: "Lead created but initial activity failed", table: "location_pipeline_activities", profile, error: activityResult.error, extra: { lead_id: data.id } });
  }

  revalidateLocationPipeline(data.id);
  success(`/locations-pipeline/${data.id}`, "Location lead created successfully.");
}

export async function updateLocationPipelineLead(formData: FormData) {
  "use server";
  const id = String(formData.get("id") || "").trim();
  if (!id) redirect("/locations-pipeline");
  const returnPath = `/locations-pipeline/${id}`;
  const { profile, supabase } = await requireLocationPipelineAccess(returnPath);

  let payload: ReturnType<typeof parseLeadValues>;
  try {
    payload = parseLeadValues(formData, profile.team_member_id);
  } catch (error) {
    fail(returnPath, error instanceof Error ? error.message : "Could not read this lead.");
  }

  const { data: existing, error: existingError } = await supabase
    .from("location_pipeline_leads")
    .select("id, converted_location_id")
    .eq("id", id)
    .maybeSingle();

  if (existingError || !existing) {
    logLocationPipelineError({ action: "Failed to load lead before update", table: "location_pipeline_leads", profile, error: existingError, extra: { lead_id: id } });
    fail(returnPath, "This location lead could not be loaded for saving.");
  }

  if (payload.status === "machine_placed" && !existing.converted_location_id) {
    fail(returnPath, "Use Convert to active location instead of manually marking this lead as machine placed.");
  }

  const { error } = await supabase
    .from("location_pipeline_leads")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    logLocationPipelineError({ action: "Failed to update lead", table: "location_pipeline_leads", profile, error, extra: { lead_id: id, update_payload: payload } });
    fail(returnPath, "Could not save this location lead.");
  }

  revalidateLocationPipeline(id);
  success(returnPath, "Location lead updated successfully.");
}

export async function addLocationPipelineActivity(formData: FormData) {
  "use server";
  const id = String(formData.get("lead_id") || "").trim();
  if (!id) redirect("/locations-pipeline");
  const returnPath = `/locations-pipeline/${id}`;
  const { profile, supabase } = await requireLocationPipelineAccess(returnPath);

  const summary = String(formData.get("summary") || "").trim();
  if (!summary) fail(returnPath, "Activity summary is required.");
  if (summary.length > 2000) fail(returnPath, "Activity summary is too long.");

  const activityType = normalizeLocationPipelineActivityType(String(formData.get("activity_type") || "note"));
  const outcome = optionalText(formData.get("outcome"));
  const nextAction = optionalText(formData.get("activity_next_action"));
  let nextActionDate: string | null = null;
  let occurredAt: string;
  try {
    nextActionDate = optionalDate(formData.get("activity_next_action_date"));
    occurredAt = optionalDateTime(formData.get("occurred_at")) ?? new Date().toISOString();
  } catch (error) {
    fail(returnPath, error instanceof Error ? error.message : "Invalid activity date.");
  }

  const requestedStatus = optionalText(formData.get("status_after"));
  const statusAfter = requestedStatus ? normalizeLocationPipelineStatus(requestedStatus) : null;

  const { data: lead, error: leadError } = await supabase
    .from("location_pipeline_leads")
    .select("id, status, converted_location_id")
    .eq("id", id)
    .maybeSingle();
  if (leadError || !lead) fail(returnPath, "This lead could not be loaded.");
  if (statusAfter === "machine_placed" && !lead.converted_location_id) {
    fail(returnPath, "Convert the lead to an active location before marking a machine as placed.");
  }

  const { error: activityError } = await supabase.from("location_pipeline_activities").insert({
    lead_id: id,
    activity_type: activityType,
    summary,
    outcome,
    occurred_at: occurredAt,
    next_action: nextAction,
    next_action_date: nextActionDate,
    created_by_user_id: profile.team_member_id ?? null,
  });
  if (activityError) {
    logLocationPipelineError({ action: "Failed to add CRM activity", table: "location_pipeline_activities", profile, error: activityError, extra: { lead_id: id } });
    fail(returnPath, "Could not save this activity.");
  }

  const contactActivity = ["call", "whatsapp", "visit", "meeting", "proposal", "email"].includes(activityType);
  const leadUpdate: Record<string, unknown> = {
    last_activity_at: occurredAt,
    next_action: nextAction,
    next_action_date: nextActionDate,
    next_follow_up_date: nextActionDate,
    updated_at: new Date().toISOString(),
  };
  if (contactActivity) leadUpdate.last_contact_date = occurredAt.slice(0, 10);
  if (statusAfter) leadUpdate.status = statusAfter;

  const { error: updateError } = await supabase.from("location_pipeline_leads").update(leadUpdate).eq("id", id);
  if (updateError) {
    logLocationPipelineError({ action: "Activity saved but lead follow-up update failed", table: "location_pipeline_leads", profile, error: updateError, extra: { lead_id: id } });
    fail(returnPath, "Activity was saved, but the lead follow-up could not be updated.");
  }

  revalidateLocationPipeline(id);
  success(returnPath, "Activity saved.");
}

export async function convertLocationPipelineLead(formData: FormData) {
  "use server";
  const id = String(formData.get("id") || "").trim();
  if (!id) redirect("/locations-pipeline");

  const fallbackReturnPath = `/locations-pipeline/${id}`;
  const returnPath = safeReturnPath(optionalText(formData.get("return_to")), fallbackReturnPath);
  const { profile, supabase } = await requireLocationPipelineAccess(fallbackReturnPath);

  const { data: lead, error: leadError } = await supabase
    .from("location_pipeline_leads")
    .select("*")
    .eq("id", id)
    .maybeSingle<LocationPipelineLeadRow>();

  if (leadError || !lead) {
    logLocationPipelineError({ action: "Failed to load lead for conversion", table: "location_pipeline_leads", profile, error: leadError, extra: { lead_id: id } });
    fail(returnPath, "This location lead could not be loaded for conversion.");
  }

  if (lead.is_archived || lead.archived_at) fail(returnPath, "Archived leads cannot be converted.");

  if (lead.converted_location_id) {
    revalidateLocationPipeline(id);
    success(returnPath, "This lead is already linked to an active location.");
  }

  if (normalizeLocationPipelineStatus(lead.status) !== "accepted") {
    fail(returnPath, "Only won / accepted location leads can be converted to active locations.");
  }

  const address = buildLocationPipelineAddressSummary(lead);
  const notes = buildLocationPipelineNotesForLocation(lead);
  const locationDraft = {
    site_name: lead.place_name,
    area: lead.area,
    city: lead.city,
    address_text: lead.address_text ?? address,
    google_maps_url: lead.google_maps_url,
    contact_person_name: lead.contact_person_name,
    contact_person_phone: lead.contact_phone ?? lead.contact_whatsapp ?? null,
    source_location_lead_id: lead.id,
    location_type: normalizeLocationPipelinePlaceType(lead.place_type),
    rent_amount: Number(lead.rent_expectation ?? 0) || 0,
    status: "active",
    notes,
  };

  let createLocationResult = await supabase
    .from("locations")
    .insert({ ...buildLocationPayload(locationDraft), updated_at: new Date().toISOString() })
    .select("id")
    .single();
  if (createLocationResult.error && isMissingColumnError(createLocationResult.error)) {
    createLocationResult = await supabase
      .from("locations")
      .insert({ ...buildLocationLegacyPayload(locationDraft), updated_at: new Date().toISOString() })
      .select("id")
      .single();
  }
  if (createLocationResult.error && isMissingColumnError(createLocationResult.error)) {
    createLocationResult = await supabase
      .from("locations")
      .insert({ ...buildLocationMinimalPayload(locationDraft), updated_at: new Date().toISOString() })
      .select("id")
      .single();
  }

  const { data: createdLocation, error: createLocationError } = createLocationResult;
  if (createLocationError || !createdLocation?.id) {
    logLocationPipelineError({ action: "Failed to create active location", table: "locations", profile, error: createLocationError, extra: { lead_id: id, insert_payload: locationDraft } });
    fail(returnPath, "Could not convert this lead into an active location.");
  }

  const convertedAt = new Date().toISOString();
  const { error: updateLeadError } = await supabase
    .from("location_pipeline_leads")
    .update({
      converted_location_id: createdLocation.id,
      converted_at: convertedAt,
      converted_by_user_id: profile.team_member_id ?? null,
      status: "machine_placed",
      next_action: null,
      next_action_date: null,
      next_follow_up_date: null,
      updated_at: convertedAt,
    })
    .eq("id", id);

  if (updateLeadError) {
    logLocationPipelineError({ action: "Active location created but lead link failed", table: "location_pipeline_leads", profile, error: updateLeadError, extra: { lead_id: id, created_location_id: createdLocation.id } });
    fail(returnPath, "The active location was created, but this lead could not be linked afterward.");
  }

  await supabase.from("location_pipeline_activities").insert({
    lead_id: id,
    activity_type: "status_change",
    summary: "Converted from CRM lead to active Snacky location.",
    outcome: "machine_placed",
    occurred_at: convertedAt,
    created_by_user_id: profile.team_member_id ?? null,
  });

  revalidateLocationPipeline(id);
  success(returnPath, "Converted to an active location successfully.");
}
