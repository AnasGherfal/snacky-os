import { NextResponse } from "next/server";

import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { generateSmartRoutePlan } from "@/lib/smart-route-planner";

type SmartPlanPayload = {
  machineIds?: string[];
  routeDate?: string;
  operatorId?: string | null;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  }, "/routes/new")) {
    return jsonError("You are not authorized to generate route plans.", 403);
  }

  let payload: SmartPlanPayload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("Invalid smart route request.");
  }

  const machineIds = Array.from(new Set((payload.machineIds ?? []).map(String).filter(Boolean)));
  const routeDate = String(payload.routeDate ?? "").trim();
  const operatorId = String(payload.operatorId ?? "").trim() || null;

  if (!machineIds.length) return jsonError("Choose at least one machine first.");
  if (!routeDate) return jsonError("Route date is required.");

  try {
    const plan = await generateSmartRoutePlan({
      machineIds,
      routeDate,
      operatorId,
      requestedBy: profile.team_member_id ?? null,
    });
    return NextResponse.json(plan);
  } catch (error) {
    console.error("[smart-route] Plan generation failed", {
      machineIds,
      routeDate,
      operatorId,
      error,
    });
    return jsonError(
      error instanceof Error ? error.message : "Could not generate a smart route plan.",
      500,
    );
  }
}
