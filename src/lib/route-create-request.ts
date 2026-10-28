import { createHash } from "node:crypto";

// Routes already have a UUID primary key. Reuse it as the owner's stable
// create-request identifier; this requires NO production schema migration.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isClientRouteCreateId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A retry must have the same submitted inputs as the original operation.
 * This fingerprint is server-computed, never trusted from the browser.
 */
export function routeCreateFingerprint(payload: Record<string, unknown>): string {
  const request = { ...payload };
  delete request.clientRouteId;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export type RouteReplayEvidence = {
  route: {
    id?: string | null;
    created_by?: string | null;
    route_date?: string | null;
    operator_id?: string | null;
  } | null;
  audit: {
    actor_user_id?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  actorUserId: string;
  teamMemberId: string | null;
  requestId: string;
  requestDate: string;
  operatorId: string;
  requestFingerprint: string;
};

export type RouteReplayState = "absent" | "complete" | "in_progress" | "conflict";

/** Only a final create-route audit receipt proves full child-row persistence. */
export function routeReplayState(input: RouteReplayEvidence): RouteReplayState {
  const {route,audit,actorUserId,teamMemberId,requestId,requestDate,operatorId,requestFingerprint}=input;
  if(!route)return "absent";
  if(route.id!==requestId || !teamMemberId || route.created_by!==teamMemberId
    || route.route_date!==requestDate || (route.operator_id??"")!==operatorId) return "conflict";
  if(!audit)return "in_progress";
  if(audit.actor_user_id!==actorUserId || audit.metadata?.route_create_request_fingerprint!==requestFingerprint)
    return "conflict";
  return "complete";
}
