import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { LocationPipelineLeadRow, buildLocationPipelineAddressSummary, buildLocationPipelineNotesForLocation, normalizeLocationPipelinePlaceType, normalizeLocationPipelineStatus } from "@/lib/location-pipeline";
import { requireLocationPipelineAccess } from "@/lib/location-pipeline-server";

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
  const estimatedTraffic = optionalInteger(formData.get("estimated_traffic"));
  const rentExpectation = optionalNumber(formData.get("rent_expectation"));

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
    first_contact_date: optionalDate(formData.get("first_contact_date")),
    last_contact_date: optionalDate(formData.get("last_contact_date")),
    next_follow_up_date: optionalDate(formData.get("next_follow_up_date")),
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
    .insert({ ...payload, created_at: now, updated_at: now })
    .select("id")
    .single();

  if (error || !data?.id) {
    console.error("[locations-pipeline] Failed to create lead", { error, payload });
    fail(returnPath, "Could not create this location lead.");
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
    console.error("[locations-pipeline] Failed to load lead before update", { id, error: existingError });
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
    console.error("[locations-pipeline] Failed to update lead", { id, error, payload });
    fail(returnPath, "Could not save this location lead.");
  }

  revalidateLocationPipeline(id);
  success(returnPath, "Location lead updated successfully.");
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
    console.error("[locations-pipeline] Failed to load lead for conversion", { id, error: leadError });
    fail(returnPath, "This location lead could not be loaded for conversion.");
  }

  if (lead.archived_at) {
    fail(returnPath, "Archived leads cannot be converted.");
  }

  if (lead.converted_location_id) {
    revalidateLocationPipeline(id);
    success(returnPath, "This lead is already linked to an active location.");
  }

  if (normalizeLocationPipelineStatus(lead.status) !== "accepted") {
    fail(returnPath, "Only accepted location leads can be converted to active locations.");
  }

  const address = buildLocationPipelineAddressSummary(lead);
  const notes = buildLocationPipelineNotesForLocation(lead);
  const locationPayload = {
    name: lead.place_name,
    location_type: normalizeLocationPipelinePlaceType(lead.place_type),
    address,
    contact_name: lead.contact_person_name,
    contact_phone: lead.contact_phone ?? lead.contact_whatsapp ?? null,
    rent_amount: lead.rent_expectation ?? 0,
    status: "active",
    notes,
    updated_at: new Date().toISOString(),
  };

  const { data: createdLocation, error: createLocationError } = await supabase
    .from("locations")
    .insert(locationPayload)
    .select("id")
    .single();

  if (createLocationError || !createdLocation?.id) {
    console.error("[locations-pipeline] Failed to create active location", { leadId: id, error: createLocationError, locationPayload });
    fail(returnPath, "Could not convert this lead into an active location.");
  }

  const { error: updateLeadError } = await supabase
    .from("location_pipeline_leads")
    .update({
      status: "machine_placed",
      converted_location_id: createdLocation.id,
      converted_at: new Date().toISOString(),
      converted_by_user_id: profile.team_member_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateLeadError) {
    console.error("[locations-pipeline] Active location created but lead link failed", {
      leadId: id,
      createdLocationId: createdLocation.id,
      error: updateLeadError,
    });
    fail(returnPath, "The active location was created, but this lead could not be linked afterward.");
  }

  revalidateLocationPipeline(id);
  success(returnPath, "Converted to an active location successfully.");
}
