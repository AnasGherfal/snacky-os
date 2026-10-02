import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole, normalizeRoles } from "@/lib/authz";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

const INSTRUCTION_TYPES = new Set(["task", "price_change", "note"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  const row = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  } | null;
  return [row?.code, row?.message, row?.details, row?.hint]
    .map((value) => clean(value))
    .filter(Boolean)
    .join(" · ") || "Operator instruction request failed.";
}

function setupError(error: unknown) {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("operator_instructions") ||
    text.includes("create_operator_instruction") ||
    text.includes("advance_operator_instruction") ||
    text.includes("pgrst202") ||
    text.includes("pgrst205") ||
    text.includes("schema cache")
  );
}

function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: message, ...extra }, { status });
}

async function context() {
  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const sessionClient = getSupabaseServerClient(accessToken);
  return {
    profile,
    sessionClient,
    readClient: getSupabaseAdminClient() ?? sessionClient,
  };
}

function isOperatorMember(row: { role?: unknown; roles?: unknown }) {
  return normalizeRoles(row.roles, clean(row.role)).includes("operator");
}

function uniqueIds(values: unknown[]) {
  return Array.from(new Set(values.map(clean).filter(Boolean)));
}

async function loadOperatorOptions(readClient: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const result = await readClient
    .from("team_members")
    .select("id, full_name, role, roles, active, active_status")
    .order("full_name");
  if (result.error) throw result.error;
  return (result.data ?? []).filter(
    (row: any) => row.active !== false && clean(row.active_status || "active") !== "inactive" && isOperatorMember(row),
  );
}

export async function GET(request: Request) {
  const { profile, sessionClient, readClient } = await context();
  if (!profile || !sessionClient || !readClient) return jsonError("Session expired.", 401);

  const manager = isOwnerAdminRole(profile);
  const url = new URL(request.url);
  const requestedOperatorId = clean(url.searchParams.get("operatorId"));
  const includeOptions = url.searchParams.get("includeOptions") === "1";

  try {
    const operators = manager ? await loadOperatorOptions(readClient) : [];
    const ownOperatorId = clean(profile.team_member_id);
    const operatorId = manager
      ? requestedOperatorId || clean(operators[0]?.id)
      : ownOperatorId;

    if (!operatorId) {
      return jsonError(
        manager ? "No active operator is available." : "Operator profile is not linked.",
        manager ? 404 : 403,
      );
    }
    if (!manager && requestedOperatorId && requestedOperatorId !== ownOperatorId) {
      return jsonError("You can only view your own instructions.", 403);
    }
    if (manager && operators.length && !operators.some((row: any) => clean(row.id) === operatorId)) {
      return jsonError("Operator not found or inactive.", 404);
    }

    const instructionsResult = await readClient
      .from("operator_instructions")
      .select("*")
      .eq("operator_id", operatorId)
      .order("created_at", { ascending: false })
      .limit(300);

    if (instructionsResult.error) {
      if (setupError(instructionsResult.error)) {
        return jsonError(
          "Operator instructions are not installed in the production database.",
          503,
          {
            setupRequired: true,
            migration: "202608040001_operator_instructions.sql",
            details: errorText(instructionsResult.error),
          },
        );
      }
      throw instructionsResult.error;
    }

    const instructions = (instructionsResult.data ?? []) as any[];
    const productIds = uniqueIds(instructions.map((row) => row.product_id));
    const machineIds = uniqueIds(instructions.map((row) => row.machine_id));
    const routeIds = uniqueIds(instructions.map((row) => row.route_id));
    const memberIds = uniqueIds(
      instructions.flatMap((row) => [
        row.created_by_member_id,
        row.acknowledged_by_member_id,
        row.completed_by_member_id,
        row.cancelled_by_member_id,
      ]),
    );

    const [relatedProducts, relatedMachines, relatedRoutes, relatedMembers, productOptions, machineOptions, routeOptions] = await Promise.all([
      productIds.length
        ? readClient.from("products").select("id, name, brand, category, current_selling_price_lyd, selling_price, active").in("id", productIds)
        : Promise.resolve({ data: [], error: null }),
      machineIds.length
        ? readClient.from("machines").select("id, name, machine_code, status").in("id", machineIds)
        : Promise.resolve({ data: [], error: null }),
      routeIds.length
        ? readClient.from("routes").select("id, route_date, status, operator_id").in("id", routeIds)
        : Promise.resolve({ data: [], error: null }),
      memberIds.length
        ? readClient.from("team_members").select("id, full_name").in("id", memberIds)
        : Promise.resolve({ data: [], error: null }),
      manager && includeOptions
        ? readClient.from("products").select("id, name, brand, category, current_selling_price_lyd, selling_price, active").eq("active", true).order("name")
        : Promise.resolve({ data: [], error: null }),
      manager && includeOptions
        ? readClient.from("machines").select("id, name, machine_code, status").order("name")
        : Promise.resolve({ data: [], error: null }),
      manager && includeOptions
        ? readClient.from("routes").select("id, route_date, status, operator_id").eq("operator_id", operatorId).order("route_date", { ascending: false }).limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const supportingResults = [
      relatedProducts,
      relatedMachines,
      relatedRoutes,
      relatedMembers,
      productOptions,
      machineOptions,
      routeOptions,
    ];
    const failed = supportingResults.find((result) => result.error);
    if (failed?.error) throw failed.error;

    const productsById = new Map((relatedProducts.data ?? []).map((row: any) => [clean(row.id), row]));
    const machinesById = new Map((relatedMachines.data ?? []).map((row: any) => [clean(row.id), row]));
    const routesById = new Map((relatedRoutes.data ?? []).map((row: any) => [clean(row.id), row]));
    const membersById = new Map((relatedMembers.data ?? []).map((row: any) => [clean(row.id), row]));

    return NextResponse.json({
      success: true,
      manager,
      operatorId,
      currentOperatorId: ownOperatorId || null,
      operators,
      products: productOptions.data ?? [],
      machines: machineOptions.data ?? [],
      routes: routeOptions.data ?? [],
      instructions: instructions.map((row) => ({
        ...row,
        product: productsById.get(clean(row.product_id)) ?? null,
        machine: machinesById.get(clean(row.machine_id)) ?? null,
        route: routesById.get(clean(row.route_id)) ?? null,
        createdByName: membersById.get(clean(row.created_by_member_id))?.full_name ?? null,
        acknowledgedByName: membersById.get(clean(row.acknowledged_by_member_id))?.full_name ?? null,
        completedByName: membersById.get(clean(row.completed_by_member_id))?.full_name ?? null,
        cancelledByName: membersById.get(clean(row.cancelled_by_member_id))?.full_name ?? null,
      })),
    });
  } catch (error) {
    console.error("[operator-instructions] GET failed", {
      user_id: profile.id,
      requested_operator_id: requestedOperatorId || null,
      error: errorText(error),
    });
    return jsonError("Could not load operator instructions.", 500, { details: errorText(error) });
  }
}

export async function POST(request: Request) {
  const { profile, sessionClient } = await context();
  if (!profile || !sessionClient) return jsonError("Session expired.", 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request.", 400);
  }

  const action = clean(body.action);
  const manager = isOwnerAdminRole(profile);

  try {
    if (action === "create") {
      if (!manager) return jsonError("Only owner/admin can assign instructions.", 403);

      const operatorId = clean(body.operatorId);
      const instructionType = clean(body.instructionType || "task").toLowerCase();
      const priority = clean(body.priority || "normal").toLowerCase();
      const title = clean(body.title);
      const details = clean(body.details);
      const productId = clean(body.productId);
      const machineId = clean(body.machineId);
      const routeId = clean(body.routeId);
      const requestedSellingPrice = numberValue(body.requestedSellingPriceLyd);
      const clientSubmissionId = clean(body.clientSubmissionId) || `operator-instruction:${crypto.randomUUID()}`;

      if (!operatorId) return jsonError("Operator is required.");
      if (!INSTRUCTION_TYPES.has(instructionType)) return jsonError("Invalid instruction type.");
      if (!PRIORITIES.has(priority)) return jsonError("Invalid priority.");
      if (instructionType === "task" && !title) return jsonError("Task title is required.");
      if (instructionType === "note" && !title && !details) return jsonError("Write a note for the operator.");
      if (instructionType === "price_change" && !productId) return jsonError("Select a product.");
      if (instructionType === "price_change" && requestedSellingPrice <= 0) return jsonError("Enter a valid new selling price.");

      const result = await sessionClient.rpc("create_operator_instruction", {
        p_operator_id: operatorId,
        p_instruction_type: instructionType,
        p_title: title || null,
        p_details: details || null,
        p_priority: priority,
        p_requires_completion: instructionType !== "note",
        p_product_id: productId || null,
        p_machine_id: machineId || null,
        p_route_id: routeId || null,
        p_requested_selling_price_lyd: instructionType === "price_change" ? requestedSellingPrice : null,
        p_due_at: clean(body.dueAt) || null,
        p_client_submission_id: clientSubmissionId,
      });
      if (result.error) throw result.error;

      revalidatePath("/operator/routes");
      revalidatePath(`/team/${operatorId}`);
      if (instructionType === "price_change" && productId) {
        revalidatePath("/products");
        revalidatePath(`/products/${productId}/edit`);
        revalidatePath(`/products/${productId}/history`);
      }

      return NextResponse.json({ success: true, data: result.data });
    }

    if (!["acknowledge", "complete", "cancel"].includes(action)) {
      return jsonError("Unknown action.");
    }
    if (action === "cancel" && !manager) {
      return jsonError("Only owner/admin can cancel instructions.", 403);
    }

    const instructionId = clean(body.instructionId);
    if (!instructionId) return jsonError("Instruction is required.");

    const result = await sessionClient.rpc("advance_operator_instruction", {
      p_instruction_id: instructionId,
      p_action: action,
      p_note: clean(body.note) || null,
    });
    if (result.error) throw result.error;

    revalidatePath("/operator/routes");
    const resultRow = Array.isArray(result.data) ? result.data[0] : result.data;
    const operatorId = clean((resultRow as any)?.operator_id);
    if (operatorId) revalidatePath(`/team/${operatorId}`);

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    const text = errorText(error);
    const lowered = text.toLowerCase();
    const status = setupError(error)
      ? 503
      : lowered.includes("only owner") || lowered.includes("only update your own") || lowered.includes("authorized") || lowered.includes("42501")
        ? 403
        : lowered.includes("not found") || lowered.includes("p0002")
          ? 404
          : 400;

    console.error("[operator-instructions] POST failed", {
      user_id: profile.id,
      action,
      error: text,
    });

    return jsonError(text, status, setupError(error) ? {
      setupRequired: true,
      migration: "202608040001_operator_instructions.sql",
    } : undefined);
  }
}
