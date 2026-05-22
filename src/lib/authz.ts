export const appRoles = ["owner", "admin", "supervisor", "operator", "warehouse", "purchasing", "finance", "viewer"] as const;

export type AppRole = (typeof appRoles)[number];

export type AuthUserContext = {
  id: string;
  role: AppRole;
  roles?: AppRole[] | null;
  canAddProducts?: boolean | null;
  teamMemberId?: string | null;
  activeStatus?: "active" | "inactive";
};

const ownerAdminRoles = new Set<AppRole>(["owner", "admin"]);
const supervisorRoles = new Set<AppRole>(["supervisor"]);
const adminRoles = new Set<AppRole>(["owner", "admin", "supervisor"]);
const operatorRoles = new Set<AppRole>(["operator"]);
const routePerformerRoles = new Set<AppRole>(["owner", "admin", "supervisor", "operator"]);
const financeRoles = new Set<AppRole>(["owner", "admin", "supervisor", "finance"]);
const storageLocationRoles = new Set<AppRole>(["owner", "admin", "supervisor", "warehouse"]);
const purchasingRoles = new Set<AppRole>(["owner", "admin", "supervisor", "purchasing"]);
const productCreatorRoles = new Set<AppRole>(["owner", "admin"]);

type RoleInput = AppRole | AppRole[] | AuthUserContext | null | undefined;

const rolePriority: AppRole[] = ["owner", "admin", "supervisor", "finance", "warehouse", "purchasing", "operator", "viewer"];

function normalizeRole(role: string | null | undefined): AppRole | null {
  const normalized = role === "procurement" ? "purchasing" : role;
  return appRoles.includes(normalized as AppRole) ? (normalized as AppRole) : null;
}

export function normalizeRoles(roles: unknown, fallback?: string | null): AppRole[] {
  const rawRoles = Array.isArray(roles) ? roles : roles ? [roles] : [];
  const normalized = rawRoles
    .map((role) => normalizeRole(String(role)))
    .filter((role): role is AppRole => Boolean(role));
  const fallbackRole = normalizeRole(fallback);
  if (fallbackRole) normalized.push(fallbackRole);
  const unique = Array.from(new Set(normalized));
  unique.sort((a, b) => rolePriority.indexOf(a) - rolePriority.indexOf(b));
  return unique.length ? unique : ["viewer"];
}

function rolesFrom(input: RoleInput): AppRole[] {
  if (!input) return [];
  if (typeof input === "string") return normalizeRoles([input]);
  if (Array.isArray(input)) return normalizeRoles(input);
  return normalizeRoles(input.roles, input.role);
}

export function hasRole(input: RoleInput, role: AppRole) {
  return rolesFrom(input).includes(role);
}

export function hasAnyRole(input: RoleInput, roles: Iterable<AppRole>) {
  const allowed = new Set(roles);
  return rolesFrom(input).some((role) => allowed.has(role));
}

export function isAdminRole(input: RoleInput) {
  return hasAnyRole(input, adminRoles);
}

export function isOwnerAdminRole(input: RoleInput) {
  return hasAnyRole(input, ownerAdminRoles);
}

export function isSupervisorRole(input: RoleInput) {
  return hasAnyRole(input, supervisorRoles);
}

export function isOperatorRole(input: RoleInput) {
  return hasAnyRole(input, operatorRoles);
}

export function canExecuteRoutes(input: RoleInput) {
  return hasAnyRole(input, routePerformerRoles);
}

export function canManageOperations(user: AuthUserContext | null | undefined) {
  return isAdminRole(user);
}

export function canViewFinancials(user: AuthUserContext | null | undefined) {
  return hasAnyRole(user, financeRoles);
}

export function canEditFinancialTransactions(user: AuthUserContext | null | undefined) {
  return isOwnerAdminRole(user) || hasRole(user, "finance");
}

export function canManageStorageLocations(input: RoleInput) {
  return hasAnyRole(input, storageLocationRoles);
}

export function canManagePurchases(input: RoleInput) {
  return hasAnyRole(input, new Set<AppRole>([...purchasingRoles, "warehouse"]));
}

export function canScanReceipts(input: RoleInput) {
  return canManagePurchases(input);
}

export function canAddProducts(input: RoleInput) {
  if (!input) return false;
  if (isOwnerAdminRole(input)) return true;
  if (typeof input === "object" && !Array.isArray(input) && input.canAddProducts) return true;
  return hasAnyRole(input, productCreatorRoles);
}

export function canAccessOperatorRoute(user: AuthUserContext | null | undefined, routeOperatorId: string | null | undefined) {
  if (!user) return false;
  if (canManageOperations(user)) return true;
  if (!routeOperatorId) return canExecuteRoutes(user);
  return isOperatorRole(user) && Boolean(user.teamMemberId) && user.teamMemberId === routeOperatorId;
}

export function getDefaultPathForRole(input: RoleInput) {
  if (isOwnerAdminRole(input) || isSupervisorRole(input)) return "/dashboard";
  if (hasRole(input, "finance")) return "/finance";
  if (hasRole(input, "warehouse")) return "/inventory";
  if (hasRole(input, "purchasing")) return "/purchases";
  if (isOperatorRole(input)) return "/operator/routes";
  return "/dashboard";
}

export function parseAppRole(role: string | null | undefined): AppRole | null {
  return normalizeRole(role);
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
const purchasingAllowedPrefixes = ["/purchases", "/products", "/suppliers"];
const financeAllowedPrefixes = ["/finance", "/cash-collections", "/purchases"];
const viewerAllowedPrefixes = ["/dashboard"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function canAccessPath(user: AuthUserContext | null | undefined, pathname: string) {
  if (!user || user.activeStatus === "inactive") return false;
  if (pathname === "/account" || pathname.startsWith("/account/")) return true;
  if (pathname === "/install" || pathname.startsWith("/install/")) return true;
  if (user.canAddProducts && (pathname === "/products/new" || pathname.startsWith("/products/new/"))) return true;
  if (isOwnerAdminRole(user)) return true;
  if (isSupervisorRole(user) && matchesPrefix(pathname, supervisorAllowedPrefixes)) return true;
  if (isOperatorRole(user) && matchesPrefix(pathname, operatorAllowedPrefixes)) return true;
  if (hasRole(user, "warehouse") && matchesPrefix(pathname, warehouseAllowedPrefixes)) return true;
  if (hasRole(user, "purchasing") && matchesPrefix(pathname, purchasingAllowedPrefixes)) return true;
  if (hasRole(user, "finance") && matchesPrefix(pathname, financeAllowedPrefixes)) return true;
  return hasRole(user, "viewer") && matchesPrefix(pathname, viewerAllowedPrefixes);
}
