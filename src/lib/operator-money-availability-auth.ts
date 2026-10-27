import { normalizeRoles } from "./authz.ts";

type PurchaseAvailabilityProfile = {
  active_status?: string | null;
  team_member_id?: string | null;
  role?: string | null;
  roles?: unknown;
};

/**
 * The purchase availability API uses a service-role read to inspect actual
 * storage quantities. Restrict that narrowly-scoped read to active, linked
 * Snacky staff who can legitimately make employee purchase requests.
 * Investors, passive viewers, inactive and unlinked accounts must not use it.
 * This does not grant inventory permissions or authorize purchase writes.
 */
const internalPurchaseRoles = new Set([
  "owner", "admin", "supervisor", "crm", "operator", "warehouse", "purchasing", "finance",
]);

export function canReadOperatorPurchaseAvailability(
  profile: PurchaseAvailabilityProfile | null | undefined,
): boolean {
  if (!profile || profile.active_status !== "active"
    || typeof profile.team_member_id !== "string" || !profile.team_member_id.trim()) return false;
  return normalizeRoles(profile.roles, profile.role).some(role => internalPurchaseRoles.has(role));
}
