import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { crmDispatchSameOrigin } from "@/lib/crm-dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});

export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["owner", "admin", "supervisor", "crm", "operator"])) {
    return json({ ok: false, error: "Active staff sign-in required." }, 403);
  }
  const taskId = new URL(request.url).searchParams.get("task_id") ?? "";
  if (!uuid.test(taskId)) return json({ ok: false, error: "Invalid repair task." }, 400);
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return json({ ok: false, error: "Session unavailable. Sign in again." }, 503);
  const { data, error } = await db.rpc("snacky_repair_sale_workspace_v1", { p_task_id: taskId });
  if (error) return json({ ok: false, error: error.code === "42501" ? "This repair is not available to you." : "Could not load repair sales. Refresh and retry." }, error.code === "42501" ? 403 : 503);
  if (!data || data.ok !== true || data.task_id !== taskId) return json({ ok: false, error: "Repair sale data could not be verified." }, 503);
  return json(data);
}

export async function POST(request: Request) {
  if (!crmDispatchSameOrigin(request)) return json({ ok: false, retryable: false, error: "Invalid origin." }, 403);
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["operator", "owner", "admin", "supervisor"])) {
    return json({ ok: false, retryable: true, error: "Sign in as the assigned repair operator, then retry the saved sale." }, 403);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 12000) return json({ ok: false, retryable: false, error: "Request is too large." }, 413);
  let command: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 12000) throw new Error("Too large");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    command = value as Record<string, unknown>;
    if (!uuid.test(String(command.request_id ?? "")) || !uuid.test(String(command.task_id ?? ""))
      || !uuid.test(String(command.product_id ?? "")) || !Number.isInteger(command.quantity)
      || Number(command.quantity) < 1 || Number(command.quantity) > 500
      || !["machine", "operator_bag"].includes(String(command.stock_source))
      || typeof command.unit_price_lyd !== "number" || !Number.isFinite(command.unit_price_lyd)
      || command.unit_price_lyd <= 0 || command.unit_price_lyd > 1000
      || command.cash_in_machine !== true || command.new_unrecorded_payment !== true) throw new Error("Invalid sale");
  } catch {
    return json({ ok: false, retryable: false, error: "Check the product, quantity and cashbox confirmations." }, 400);
  }
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return json({ ok: false, retryable: true, error: "Keep the saved sale and sign in again." }, 503);
  try {
    const { data, error } = await db.rpc("snacky_create_repair_manual_sale_v1", { p_command: command });
    if (error) {
      // A definitive SQL rollback unlocks the input; transport uncertainty or
      // an identity collision must keep the exact request for safe retry.
      const knownRollback = ["22023", "22P02", "23514", "23503", "42501", "40001", "57014"].includes(String(error.code));
      const status = error.code === "42501" ? 403 : knownRollback ? 409 : 503;
      return json({ ok: false, retryable: !knownRollback, error: knownRollback ? error.message : "Save not confirmed. Retry the same saved request; do not create a second sale." }, status);
    }
    if (!data || data.ok !== true || data.request_id !== command.request_id
      || data.task_id !== command.task_id || !uuid.test(String(data.sale_id ?? ""))
      || data.cash_destination !== "machine_cashbox") {
      return json({ ok: false, retryable: true, error: "Sale receipt was not confirmed. Retry the same saved request." }, 503);
    }
    const taskId = String(command.task_id);
    for (const path of [`/follow-ups/${taskId}`, "/operator/issues", "/inventory", "/inventory/movements", "/sales", "/reports/route-product-activity", "/cash-collections"]) revalidatePath(path);
    return json(data);
  } catch {
    return json({ ok: false, retryable: true, error: "Connection interrupted. Retry the saved sale to avoid double-counting." }, 503);
  }
}
