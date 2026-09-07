"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { isAdminRole } from "@/lib/authz";
import { isMissingRouteInventoryReviewSchema, routeInventoryErrorText } from "@/lib/route-inventory-discrepancies";

const REVIEW_PATH = "/routes/inventory-review";
const REVIEW_ACTIONS = new Set(["start_investigation", "accept_reconciled_variance", "reopen"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function safeReturnTo(value: FormDataEntryValue | null, routeId: string) {
  const candidate = clean(value);
  if (!candidate.startsWith("/")) return REVIEW_PATH;

  try {
    const url = new URL(candidate, "https://snacky.invalid");
    const routeDetailPath = UUID_PATTERN.test(routeId) ? `/routes/${routeId}` : "";
    if (url.origin !== "https://snacky.invalid") return REVIEW_PATH;
    if (url.pathname !== REVIEW_PATH && url.pathname !== routeDetailPath) return REVIEW_PATH;
    url.searchParams.delete("success");
    url.searchParams.delete("error");
    return `${url.pathname}${url.search}`;
  } catch {
    return REVIEW_PATH;
  }
}

function redirectWithMessage(path: string, key: "success" | "error", message: string): never {
  const url = new URL(path, "https://snacky.invalid");
  url.searchParams.set(key, message);
  redirect(`${url.pathname}${url.search}`);
}

function publicReviewError(error: unknown) {
  const text = routeInventoryErrorText(error);
  const lower = text.toLowerCase();
  if (isMissingRouteInventoryReviewSchema(error)) return "Inventory discrepancy review is not installed in the database yet.";
  if (lower.includes("changed after the page loaded") || lower.includes("40001")) return "This discrepancy changed. Refresh the page and review its latest status.";
  if (lower.includes("no linked correcting movement") || lower.includes("reconcile inventory before accepting")) return "This variance cannot be accepted until its correcting inventory movement is linked.";
  if (lower.includes("only an open") || lower.includes("only a closed")) return "This discrepancy is no longer in the required review state. Refresh and try again.";
  if (lower.includes("permission") || lower.includes("owner, admin, or supervisor") || lower.includes("42501")) return "You do not have permission to review this inventory discrepancy.";
  return "The inventory discrepancy review could not be saved. Refresh and try again.";
}

export async function reviewRouteInventoryDiscrepancy(formData: FormData) {
  const discrepancyId = clean(formData.get("discrepancy_id"));
  const routeId = clean(formData.get("route_id"));
  const action = clean(formData.get("review_action"));
  const notes = clean(formData.get("reason"));
  const clientSubmissionId = clean(formData.get("client_submission_id"));
  const expectedUpdatedAt = clean(formData.get("expected_updated_at"));
  const returnTo = safeReturnTo(formData.get("return_to"), routeId);

  const profile = await getCurrentProfile();
  if (!profile || !isAdminRole(profile)) redirect("/unauthorized");

  if (!UUID_PATTERN.test(discrepancyId) || !UUID_PATTERN.test(routeId)) {
    redirectWithMessage(returnTo, "error", "A valid route inventory discrepancy is required.");
  }
  if (!REVIEW_ACTIONS.has(action)) {
    redirectWithMessage(returnTo, "error", "Select a valid inventory review action.");
  }
  if (!clientSubmissionId) {
    redirectWithMessage(returnTo, "error", "The review submission is missing its safety key. Refresh and try again.");
  }
  if (action !== "start_investigation" && !notes) {
    redirectWithMessage(returnTo, "error", "Review notes are required for this action.");
  }

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirectWithMessage(returnTo, "error", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("snacky_resolve_route_inventory_discrepancy_v1", {
    p_discrepancy_id: discrepancyId,
    p_action: action,
    p_notes: notes || null,
    p_client_submission_id: clientSubmissionId,
    p_expected_updated_at: expectedUpdatedAt || null,
  });

  if (error) {
    console.error("[route-inventory-review] Review action failed", {
      discrepancy_id: discrepancyId,
      route_id: routeId,
      action,
      error,
    });
    redirectWithMessage(returnTo, "error", publicReviewError(error));
  }

  const row = (Array.isArray(data) ? data[0] : data) as { already_applied?: boolean } | null;
  revalidatePath(REVIEW_PATH);
  revalidatePath("/routes");
  revalidatePath(`/routes/${routeId}`);
  revalidatePath(`/operator/routes/${routeId}`);
  revalidatePath("/dashboard");
  revalidatePath("/admin/system-health");

  const messages: Record<string, string> = {
    start_investigation: "Inventory discrepancy moved into investigation.",
    accept_reconciled_variance: "Reconciled inventory variance accepted and closed.",
    reopen: "Inventory discrepancy reopened for review.",
  };
  const suffix = row?.already_applied ? " The earlier saved result was reused safely." : "";
  redirectWithMessage(returnTo, "success", `${messages[action]}${suffix}`);
}
