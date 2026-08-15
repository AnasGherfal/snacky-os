import { NextResponse } from "next/server";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canAccessOperatorRoute, canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { buildOperatorRouteAccessContext } from "@/lib/operator-route-access";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const row = error as { message?: unknown; details?: unknown; hint?: unknown } | null;
  return clean(row?.message ?? row?.details ?? row?.hint) || "Unknown database error";
}

function isMissingTable(error: unknown) {
  const row = error as { code?: unknown; message?: unknown } | null;
  return row?.code === "PGRST205" || String(row?.message ?? "").includes("route_customer_compensations");
}

function userContext(profile: NonNullable<Awaited<ReturnType<typeof getCurrentProfile>>>) {
  return {
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
}

function uniqueIds(values: unknown[]) {
  return Array.from(new Set(values.map(clean).filter(isUuid)));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const routeId = clean(url.searchParams.get("routeId"));
  const machineId = clean(url.searchParams.get("machineId"));
  const operatorId = clean(url.searchParams.get("operatorId"));
  const scopes = [
    routeId ? { type: "route" as const, id: routeId } : null,
    machineId ? { type: "machine" as const, id: machineId } : null,
    operatorId ? { type: "operator" as const, id: operatorId } : null,
  ].filter(Boolean) as Array<{ type: "route" | "machine" | "operator"; id: string }>;

  if (scopes.length !== 1 || !isUuid(scopes[0]?.id)) {
    return NextResponse.json(
      { success: false, error: "Provide exactly one valid routeId, machineId, or operatorId." },
      { status: 400 },
    );
  }

  const accessToken = await getAuthAccessToken();
  const profile = await getCurrentProfile();
  const authClient = getSupabaseServerClient(accessToken);
  const readClient = getSupabaseAdminClient() ?? authClient;
  if (!accessToken || !profile) {
    return NextResponse.json({ success: false, error: "Session expired. Please sign in again." }, { status: 401 });
  }
  if (!authClient || !readClient) {
    return NextResponse.json({ success: false, error: "Database is not available." }, { status: 500 });
  }

  const scope = scopes[0];
  let scopeLabel = "";

  if (scope.type === "route") {
    const { data: route, error } = await authClient
      .from("routes")
      .select("id, route_date, operator_id, status")
      .eq("id", scope.id)
      .maybeSingle();
    if (error) return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
    if (!route) return NextResponse.json({ success: false, error: "Route not found." }, { status: 404 });
    const routeAccess = await buildOperatorRouteAccessContext(authClient, profile);
    if (!canAccessOperatorRoute(routeAccess, route.operator_id)) {
      return NextResponse.json({ success: false, error: "You cannot view this route." }, { status: 403 });
    }
    scopeLabel = route.route_date ? `Route ${route.route_date}` : "Route";
  } else if (scope.type === "machine") {
    if (!canAccessPath(userContext(profile), `/machines/${scope.id}`)) {
      return NextResponse.json({ success: false, error: "You cannot view this machine." }, { status: 403 });
    }
    const { data: machine, error } = await readClient
      .from("machines")
      .select("id, name, machine_code, location:locations(id, name)")
      .eq("id", scope.id)
      .maybeSingle();
    if (error) return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
    if (!machine) return NextResponse.json({ success: false, error: "Machine not found." }, { status: 404 });
    scopeLabel = formatMachineDisplayName(machine as any, { includeArea: true });
  } else {
    const viewingSelf = profile.team_member_id === scope.id;
    if (!isOwnerAdminRole(profile) && !viewingSelf) {
      return NextResponse.json({ success: false, error: "You cannot view this operator history." }, { status: 403 });
    }
    const { data: member, error } = await readClient
      .from("team_members")
      .select("id, full_name")
      .eq("id", scope.id)
      .maybeSingle();
    if (error) return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
    if (!member) return NextResponse.json({ success: false, error: "Operator not found." }, { status: 404 });
    scopeLabel = member.full_name ?? "Operator";
  }

  let compensationQuery = readClient
    .from("route_customer_compensations")
    .select(
      "id, route_id, route_stop_id, machine_id, location_id, operator_id, product_id, product_name, quantity, claim_type, claimed_amount_lyd, notes, compensated_at, inventory_movement_id, needs_review, review_reason",
    )
    .order("compensated_at", { ascending: false })
    .limit(1000);

  if (scope.type === "route") compensationQuery = compensationQuery.eq("route_id", scope.id);
  if (scope.type === "machine") compensationQuery = compensationQuery.eq("machine_id", scope.id);
  if (scope.type === "operator") compensationQuery = compensationQuery.eq("operator_id", scope.id);

  const { data: compensationRows, error: compensationError } = await compensationQuery;
  if (compensationError && isMissingTable(compensationError)) {
    return NextResponse.json({
      success: true,
      installed: false,
      scope: { type: scope.type, id: scope.id, label: scopeLabel },
      records: [],
      totals: null,
    });
  }
  if (compensationError) {
    return NextResponse.json({ success: false, installed: true, error: errorMessage(compensationError) }, { status: 500 });
  }

  const rows = compensationRows ?? [];
  const routeIds = uniqueIds(rows.map((row: any) => row.route_id));
  const machineIds = uniqueIds(rows.map((row: any) => row.machine_id));
  const operatorIds = uniqueIds(rows.map((row: any) => row.operator_id));
  const movementIds = uniqueIds(rows.map((row: any) => row.inventory_movement_id));

  const [routesResult, machinesResult, operatorsResult, movementsResult] = await Promise.all([
    routeIds.length
      ? readClient.from("routes").select("id, route_date, status, operator_id").in("id", routeIds)
      : Promise.resolve({ data: [], error: null }),
    machineIds.length
      ? readClient.from("machines").select("id, name, machine_code, location:locations(id, name)").in("id", machineIds)
      : Promise.resolve({ data: [], error: null }),
    operatorIds.length
      ? readClient.from("team_members").select("id, full_name").in("id", operatorIds)
      : Promise.resolve({ data: [], error: null }),
    movementIds.length
      ? readClient.from("inventory_movements").select("id, quantity, unit_cost_lyd, line_total_lyd").in("id", movementIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const relatedError = routesResult.error ?? machinesResult.error ?? operatorsResult.error ?? movementsResult.error;
  if (relatedError) {
    return NextResponse.json(
      { success: false, installed: true, error: `Compensation history could not be fully loaded: ${errorMessage(relatedError)}` },
      { status: 500 },
    );
  }

  const routeById = new Map((routesResult.data ?? []).map((row: any) => [String(row.id), row]));
  const machineById = new Map((machinesResult.data ?? []).map((row: any) => [String(row.id), row]));
  const operatorById = new Map((operatorsResult.data ?? []).map((row: any) => [String(row.id), row]));
  const movementById = new Map((movementsResult.data ?? []).map((row: any) => [String(row.id), row]));

  const records = rows.map((row: any) => {
    const movement = row.inventory_movement_id ? movementById.get(String(row.inventory_movement_id)) : null;
    const movementLineTotal = numberValue(movement?.line_total_lyd);
    const movementUnitCost = numberValue(movement?.unit_cost_lyd);
    const inventoryCostLyd = movementLineTotal ?? (
      movementUnitCost === null ? null : Number((movementUnitCost * unitValue(movement?.quantity ?? row.quantity)).toFixed(2))
    );
    const machine = machineById.get(String(row.machine_id));
    const route = routeById.get(String(row.route_id));
    const operator = row.operator_id ? operatorById.get(String(row.operator_id)) : null;

    return {
      id: String(row.id),
      routeId: String(row.route_id),
      routeStopId: String(row.route_stop_id),
      machineId: String(row.machine_id),
      operatorId: row.operator_id ? String(row.operator_id) : null,
      productId: String(row.product_id),
      productName: row.product_name ?? "Unknown product",
      quantity: unitValue(row.quantity),
      claimType: row.claim_type ?? "other",
      claimedAmountLyd: numberValue(row.claimed_amount_lyd),
      notes: row.notes ?? null,
      compensatedAt: row.compensated_at,
      inventoryMovementId: row.inventory_movement_id ?? null,
      inventoryCostLyd,
      needsReview: Boolean(row.needs_review),
      reviewReason: row.review_reason ?? null,
      machine: {
        id: String(row.machine_id),
        label: formatMachineDisplayName(machine as any, { includeArea: true }),
      },
      route: {
        id: String(row.route_id),
        date: route?.route_date ?? null,
        status: route?.status ?? null,
      },
      operator: row.operator_id
        ? { id: String(row.operator_id), name: operator?.full_name ?? "Unknown operator" }
        : null,
    };
  });

  const recordsWithKnownCost = records.filter((record) => record.inventoryCostLyd !== null);
  const recordsWithClaimedAmount = records.filter((record) => record.claimedAmountLyd !== null);
  const totals = {
    entries: records.length,
    units: records.reduce((sum, record) => sum + record.quantity, 0),
    knownInventoryCostLyd: Number(recordsWithKnownCost.reduce((sum, record) => sum + Number(record.inventoryCostLyd), 0).toFixed(2)),
    knownInventoryCostRecords: recordsWithKnownCost.length,
    inventoryValueComplete: recordsWithKnownCost.length === records.length,
    claimedAmountLyd: Number(recordsWithClaimedAmount.reduce((sum, record) => sum + Number(record.claimedAmountLyd), 0).toFixed(2)),
    claimedAmountRecords: recordsWithClaimedAmount.length,
    needsReview: records.filter((record) => record.needsReview).length,
  };

  return NextResponse.json({
    success: true,
    installed: true,
    scope: { type: scope.type, id: scope.id, label: scopeLabel },
    records,
    totals,
  });
}
