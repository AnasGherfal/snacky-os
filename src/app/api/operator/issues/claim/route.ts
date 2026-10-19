import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { crmDispatchSameOrigin } from "@/lib/crm-dispatch";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});

/** One atomic claim per machine-only incident. Customer complaints remain CRM-assigned. */
export async function POST(request: Request) {
  if (!crmDispatchSameOrigin(request)) return json({ ok: false, code: "denied", message: "Invalid origin." }, 403);
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["operator"])) {
    return json({ ok: false, code: "denied", message: "Active operator sign-in required." }, 403);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2000) return json({ ok: false, code: "invalid", message: "Invalid request." }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 2000) throw new Error("Oversized request");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid payload");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "invalid", message: "Invalid claim request." }, 400);
  }
  const requestId = String(body.requestId ?? "");
  const taskId = String(body.taskId ?? "");
  if (!uuid.test(requestId) || !uuid.test(taskId)) {
    return json({ ok: false, code: "invalid", message: "Valid claim and task IDs are required." }, 400);
  }
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return json({ ok: false, code: "unavailable", retryable: true, message: "Sign in again, then retry the saved claim." }, 503);
  try {
    const { data, error } = await db.rpc("snacky_claim_machine_issue_v1", {
      p_request_id: requestId,
      p_task_id: taskId,
    });
    if (error) {
      const code = error.code === "42501" ? "denied"
        : error.code === "40001" || error.code === "23505" ? "conflict"
        : ["23514", "22023", "22P02", "23503"].includes(String(error.code)) ? "invalid" : "uncertain";
      return json({
        ok: false, code, retryable: code === "uncertain",
        message: code === "conflict" ? "Another operator may have claimed this issue. Refresh the queue."
          : code === "invalid" ? "This machine issue is no longer available."
            : code === "denied" ? "You are not allowed to claim this field task."
              : "Could not confirm the claim. Retry the exact saved request.",
      }, code === "denied" ? 403 : code === "conflict" ? 409 : code === "invalid" ? 400 : 503);
    }
    if (!data || data.ok !== true || data.request_id !== requestId || data.task_id !== taskId
      || data.action !== "claim" || data.assigned_to !== profile.team_member_id) {
      return json({ ok: false, code: "uncertain", retryable: true,
        message: "Claim result could not be verified. Retry the exact saved request." }, 503);
    }
    revalidatePath("/operator/issues");
    revalidatePath("/operator");
    revalidatePath("/follow-ups");
    revalidatePath("/issues");
    return json({ ok: true, requestId, taskId, href: `/follow-ups/${taskId}`, state: data.dispatch_state });
  } catch {
    return json({ ok: false, code: "uncertain", retryable: true,
      message: "Claim result uncertain. Retry the exact saved request." }, 503);
  }
}
