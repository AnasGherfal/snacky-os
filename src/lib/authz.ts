export const appRoles = ["owner", "admin", "supervisor", "operator", "warehouse", "procurement", "finance", "viewer"] as const;

export type AppRole = (typeof appRoles)[number];

export type AuthUserContext = {
  id: string;
  role: AppRole;
  teamMemberId?: string | null;
};

const adminRoles = new Set<AppRole>(["owner", "admin", "supervisor"]);
const operatorRoles = new Set<AppRole>(["operator"]);
const financeRoles = new Set<AppRole>(["owner", "admin", "supervisor", "finance"]);

export function isAdminRole(role: AppRole | null | undefined) {
  return role ? adminRoles.has(role) : false;
}

export function isOperatorRole(role: AppRole | null | undefined) {
  return role ? operatorRoles.has(role) : false;
}

export function canManageOperations(user: AuthUserContext | null | undefined) {
  return isAdminRole(user?.role);
}

export function canViewFinancials(user: AuthUserContext | null | undefined) {
  return user?.role ? financeRoles.has(user.role) : false;
}

export function canAccessOperatorRoute(user: AuthUserContext | null | undefined, routeOperatorId: string | null | undefined) {
  if (!user) return false;
  if (canManageOperations(user)) return true;
  return isOperatorRole(user.role) && Boolean(user.teamMemberId) && user.teamMemberId === routeOperatorId;
}

export function getDefaultPathForRole(role: AppRole | null | undefined) {
  return isOperatorRole(role) ? "/operator/routes" : "/dashboard";
}

export function parseAppRole(role: string | null | undefined): AppRole | null {
  return appRoles.includes(role as AppRole) ? (role as AppRole) : null;
}
