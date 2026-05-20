export const appRoles = ["owner", "admin", "supervisor", "operator", "warehouse", "finance", "viewer"] as const;

export type AppRole = (typeof appRoles)[number];

export type AuthUserContext = {
  id: string;
  role: AppRole;
  teamMemberId?: string | null;
  activeStatus?: "active" | "inactive";
};

const ownerAdminRoles = new Set<AppRole>(["owner", "admin"]);
const supervisorRoles = new Set<AppRole>(["supervisor"]);
const adminRoles = new Set<AppRole>(["owner", "admin", "supervisor"]);
const operatorRoles = new Set<AppRole>(["operator"]);
const financeRoles = new Set<AppRole>(["owner", "admin", "supervisor", "finance"]);
const storageLocationRoles = new Set<AppRole>(["owner", "admin", "supervisor", "warehouse"]);

export function isAdminRole(role: AppRole | null | undefined) {
  return role ? adminRoles.has(role) : false;
}

export function isOwnerAdminRole(role: AppRole | null | undefined) {
  return role ? ownerAdminRoles.has(role) : false;
}

export function isSupervisorRole(role: AppRole | null | undefined) {
  return role ? supervisorRoles.has(role) : false;
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

export function canManageStorageLocations(role: AppRole | null | undefined) {
  return role ? storageLocationRoles.has(role) : false;
}

export function canAccessOperatorRoute(user: AuthUserContext | null | undefined, routeOperatorId: string | null | undefined) {
  if (!user) return false;
  if (canManageOperations(user)) return true;
  return isOperatorRole(user.role) && Boolean(user.teamMemberId) && user.teamMemberId === routeOperatorId;
}

export function getDefaultPathForRole(role: AppRole | null | undefined) {
  if (isOperatorRole(role)) return "/operator/routes";
  if (role === "warehouse") return "/inventory";
  if (role === "finance") return "/finance";
  return "/dashboard";
}

export function parseAppRole(role: string | null | undefined): AppRole | null {
  return appRoles.includes(role as AppRole) ? (role as AppRole) : null;
}

const supervisorAllowedPrefixes = [
  "/dashboard",
  "/refills",
  "/routes",
  "/operator",
  "/cash-collections",
  "/issues",
  "/machines",
  "/machine-slots",
  "/inventory",
  "/storage-locations",
  "/purchases",
];
const operatorAllowedPrefixes = ["/operator"];
const warehouseAllowedPrefixes = ["/warehouse", "/operator", "/inventory", "/storage-locations", "/purchases"];
const financeAllowedPrefixes = ["/finance", "/cash-collections", "/purchases"];
const viewerAllowedPrefixes = ["/dashboard"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function canAccessPath(user: AuthUserContext | null | undefined, pathname: string) {
  if (!user || user.activeStatus === "inactive") return false;
  if (pathname === "/account" || pathname.startsWith("/account/")) return true;
  if (pathname === "/install" || pathname.startsWith("/install/")) return true;
  if (isOwnerAdminRole(user.role)) return true;
  if (isSupervisorRole(user.role)) return matchesPrefix(pathname, supervisorAllowedPrefixes);
  if (isOperatorRole(user.role)) return matchesPrefix(pathname, operatorAllowedPrefixes);
  if (user.role === "warehouse") return matchesPrefix(pathname, warehouseAllowedPrefixes);
  if (user.role === "finance") return matchesPrefix(pathname, financeAllowedPrefixes);
  return matchesPrefix(pathname, viewerAllowedPrefixes);
}
