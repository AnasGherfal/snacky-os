export const appRoles = ["owner", "admin", "supervisor", "operator", "warehouse", "purchasing", "finance", "investor", "viewer"] as const;

export type AppRole = (typeof appRoles)[number];

export const appPermissions = [
  "dashboard.view",
  "operations.manage",
  "routes.view",
  "routes.create",
  "assigned_routes.view",
  "assigned_machines.view",
  "refills.view",
  "refills.create",
  "issues.view",
  "issues.create",
  "products.view",
  "products.view_limited",
  "products.create",
  "products.edit",
  "products.delete",
  "inventory.view",
  "inventory.full_edit",
  "storage.view",
  "storage.adjust",
  "storage.location.manage",
  "storage.movement.view",
  "storage.movement.create",
  "purchase_items.view",
  "purchases.view",
  "purchases.create",
  "purchases.receive",
  "suppliers.view",
  "suppliers.manage",
  "machines.view",
  "machines.manage",
  "locations.pipeline.manage",
  "finance.view",
  "finance.edit",
  "investor.view",
  "reports.view",
  "team.manage",
  "activity.view",
  "vms.import",
  "vms.mapping.manage",
  "vms_import.view",
  "vms_import.create",
  "vms_import.validate",
  "vms_import.confirm",
  "vms_import.manage_mappings",
  "system.settings",
] as const;

export type AppPermission = (typeof appPermissions)[number];

export type AuthUserContext = {
  id: string;
  role: AppRole;
  roles?: AppRole[] | null;
  canAddProducts?: boolean | null;
  teamMemberId?: string | null;
  linkedTeamMemberIds?: string[] | null;
  activeStatus?: "active" | "inactive";
};

const ownerAdminRoles = new Set<AppRole>(["owner", "admin"]);
const supervisorRoles = new Set<AppRole>(["supervisor"]);
const adminRoles = new Set<AppRole>(["owner", "admin", "supervisor"]);
const operatorRoles = new Set<AppRole>(["operator"]);
const routePerformerRoles = new Set<AppRole>(["owner", "admin", "supervisor", "operator"]);

type RoleInput = AppRole | AppRole[] | AuthUserContext | null | undefined;

const rolePriority: AppRole[] = ["owner", "admin", "supervisor", "finance", "warehouse", "purchasing", "operator", "investor", "viewer"];

const rolePermissions = {
  owner: appPermissions,
  admin: appPermissions,
  supervisor: [
    "dashboard.view",
    "operations.manage",
    "routes.view",
    "routes.create",
    "assigned_routes.view",
    "assigned_machines.view",
    "refills.view",
    "refills.create",
    "issues.view",
    "issues.create",
    "products.view",
    "inventory.view",
    "inventory.full_edit",
    "storage.view",
    "storage.adjust",
    "storage.location.manage",
    "storage.movement.view",
    "storage.movement.create",
    "purchase_items.view",
    "purchases.view",
    "purchases.create",
    "purchases.receive",
    "machines.view",
    "machines.manage",
    "locations.pipeline.manage",
    "finance.view",
    "finance.edit",
    "vms.import",
    "vms.mapping.manage",
    "vms_import.view",
    "vms_import.create",
    "vms_import.validate",
    "vms_import.confirm",
    "vms_import.manage_mappings",
  ],
  operator: [
    "assigned_routes.view",
    "assigned_machines.view",
    "refills.view",
    "refills.create",
    "issues.create",
    "products.view_limited",
  ],
  warehouse: [
    "products.view",
    "products.create",
    "products.edit",
    "inventory.view",
    "storage.view",
    "storage.adjust",
    "storage.location.manage",
    "storage.movement.view",
    "storage.movement.create",
    "purchase_items.view",
    "purchases.view",
    "purchases.create",
    "purchases.receive",
  ],
  purchasing: [
    "products.view",
    "products.create",
    "products.edit",
    "purchase_items.view",
    "purchases.view",
    "purchases.create",
    "purchases.receive",
    "suppliers.view",
    "suppliers.manage",
  ],
  finance: [
    "finance.view",
    "finance.edit",
    "purchase_items.view",
    "purchases.view",
  ],
  investor: ["investor.view"],
  viewer: ["dashboard.view"],
} satisfies Record<AppRole, readonly AppPermission[]>;

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

function canCreateProductsByFlag(input: RoleInput) {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) && input.canAddProducts);
}

export function hasRole(input: RoleInput, role: AppRole) {
  return rolesFrom(input).includes(role);
}

export function hasAnyRole(input: RoleInput, roles: Iterable<AppRole>) {
  const allowed = new Set(roles);
  return rolesFrom(input).some((role) => allowed.has(role));
}

export function getEffectivePermissions(input: RoleInput): AppPermission[] {
  const permissions = new Set<AppPermission>();
  rolesFrom(input).forEach((role) => {
    rolePermissions[role].forEach((permission) => permissions.add(permission));
  });
  if (canCreateProductsByFlag(input)) permissions.add("products.create");
  return appPermissions.filter((permission) => permissions.has(permission));
}

export function hasPermission(input: RoleInput, permission: AppPermission) {
  return getEffectivePermissions(input).includes(permission);
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
  return hasPermission(user, "operations.manage");
}

export function canViewFinancials(user: AuthUserContext | null | undefined) {
  return hasPermission(user, "finance.view");
}

export function canEditFinancialTransactions(user: AuthUserContext | null | undefined) {
  return hasPermission(user, "finance.edit");
}

export function canManagePayroll(input: RoleInput) {
  return hasAnyRole(input, ["owner", "admin"]);
}

export function canApprovePayroll(input: RoleInput) {
  return hasAnyRole(input, ["owner", "admin"]);
}

export function canManageStorageLocations(input: RoleInput) {
  return hasPermission(input, "storage.location.manage");
}

export function canManageLocationPipeline(input: RoleInput) {
  return hasPermission(input, "locations.pipeline.manage");
}

export function canManagePurchases(input: RoleInput) {
  return hasPermission(input, "purchases.create") || hasPermission(input, "purchases.receive");
}

export function canScanReceipts(input: RoleInput) {
  return canManagePurchases(input);
}

export function canAddProducts(input: RoleInput) {
  return hasPermission(input, "products.create");
}

export function canViewVmsImports(input: RoleInput) {
  return hasPermission(input, "vms_import.view") || hasPermission(input, "vms.import");
}

export function canCreateVmsImports(input: RoleInput) {
  return hasPermission(input, "vms_import.create") || hasPermission(input, "vms.import");
}

export function canValidateVmsImports(input: RoleInput) {
  return hasPermission(input, "vms_import.validate") || hasPermission(input, "vms.import");
}

export function canConfirmVmsImports(input: RoleInput) {
  return hasPermission(input, "vms_import.confirm") || hasPermission(input, "vms.import");
}

export function canManageVmsMappings(input: RoleInput) {
  return hasPermission(input, "vms_import.manage_mappings") || hasPermission(input, "vms.mapping.manage");
}

export function canAccessOperatorRoute(user: AuthUserContext | null | undefined, routeOperatorId: string | null | undefined) {
  if (!user) return false;
  if (canManageOperations(user)) return true;
  if (!routeOperatorId) return canExecuteRoutes(user);
  const accessibleOperatorIds = Array.from(
    new Set(
      [user.teamMemberId, ...(user.linkedTeamMemberIds ?? [])]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
  return isOperatorRole(user) && accessibleOperatorIds.includes(String(routeOperatorId));
}

export function getDefaultPathForRole(input: RoleInput) {
  if (isOwnerAdminRole(input) || isSupervisorRole(input)) return "/dashboard";
  if (hasPermission(input, "investor.view")) return "/investor";
  if (hasPermission(input, "finance.view")) return "/finance";
  if (hasPermission(input, "inventory.view") || hasPermission(input, "storage.view")) return "/inventory";
  if (hasPermission(input, "purchases.view")) return "/purchases";
  if (isOperatorRole(input)) return "/operator/routes";
  return "/dashboard";
}

export function parseAppRole(role: string | null | undefined): AppRole | null {
  return normalizeRole(role);
}

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function canAccessPath(user: AuthUserContext | null | undefined, pathname: string) {
  if (!user || user.activeStatus === "inactive") return false;
  if (pathname === "/account" || pathname.startsWith("/account/")) return true;
  if (pathname === "/install" || pathname.startsWith("/install/")) return true;
  if (matchesPrefix(pathname, ["/investor"])) return hasPermission(user, "investor.view");

  if (pathname === "/dashboard") return hasPermission(user, "dashboard.view");
  if (matchesPrefix(pathname, ["/reports", "/sales", "/products-dashboard", "/machines-dashboard", "/inventory-dashboard"])) return hasPermission(user, "reports.view");

  if (pathname === "/products/new" || pathname.startsWith("/products/new/")) return hasPermission(user, "products.create");
  if (/^\/products\/[^/]+\/edit(?:\/|$)/.test(pathname)) return hasPermission(user, "products.edit");
  if (matchesPrefix(pathname, ["/products"])) return hasPermission(user, "products.view");

  if (pathname === "/inventory/movements/new" || pathname.startsWith("/inventory/movements/new/")) {
    return hasPermission(user, "storage.movement.create") || hasPermission(user, "storage.adjust");
  }
  if (matchesPrefix(pathname, ["/inventory/movements"])) return hasPermission(user, "storage.movement.view");
  if (matchesPrefix(pathname, ["/product-planning"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view") || hasPermission(user, "purchases.view") || hasPermission(user, "finance.view");
  if (matchesPrefix(pathname, ["/restock-priority"])) return hasPermission(user, "products.view") || hasPermission(user, "inventory.view") || hasPermission(user, "storage.view");
  if (matchesPrefix(pathname, ["/inventory", "/warehouse"])) return hasPermission(user, "inventory.view") || hasPermission(user, "storage.view");

  if (pathname === "/storage-locations/new" || pathname.startsWith("/storage-locations/new/") || /^\/storage-locations\/[^/]+\/edit(?:\/|$)/.test(pathname)) {
    return hasPermission(user, "storage.location.manage");
  }
  if (matchesPrefix(pathname, ["/storage-locations"])) return hasPermission(user, "storage.view");

  if (pathname === "/purchases/new" || pathname.startsWith("/purchases/new/") || /^\/purchases\/[^/]+\/edit(?:\/|$)/.test(pathname)) {
    return hasPermission(user, "purchases.create") || hasPermission(user, "purchases.receive");
  }
  if (matchesPrefix(pathname, ["/purchases"])) return hasPermission(user, "purchases.view") || hasPermission(user, "purchase_items.view");

  if (pathname === "/suppliers/new" || pathname.startsWith("/suppliers/new/") || /^\/suppliers\/[^/]+(?:\/|$)/.test(pathname)) return hasPermission(user, "suppliers.manage");
  if (matchesPrefix(pathname, ["/suppliers"])) return hasPermission(user, "suppliers.view");

  if (pathname === "/routes/new" || pathname.startsWith("/routes/new/")) return hasPermission(user, "routes.create");
  if (matchesPrefix(pathname, ["/routes", "/refills"])) return hasPermission(user, "routes.view") || hasPermission(user, "refills.view");
  if (matchesPrefix(pathname, ["/operator"])) return hasPermission(user, "assigned_routes.view") || hasPermission(user, "refills.view");

  if (matchesPrefix(pathname, ["/locations-pipeline"])) return canManageLocationPipeline(user);
  if (matchesPrefix(pathname, ["/machines", "/machine-slots", "/locations"])) return hasPermission(user, "machines.view");
  if (matchesPrefix(pathname, ["/issues"])) return hasPermission(user, "issues.view");

  if (pathname === "/finance/transactions/new" || pathname.startsWith("/finance/transactions/new/") || /^\/finance\/transactions\/[^/]+\/edit(?:\/|$)/.test(pathname)) {
    return hasPermission(user, "finance.edit");
  }
  if (pathname === "/cash-collections/new" || pathname.startsWith("/cash-collections/new/") || /^\/cash-collections\/[^/]+\/edit(?:\/|$)/.test(pathname)) {
    return hasPermission(user, "finance.edit");
  }
  if (matchesPrefix(pathname, ["/finance", "/cash-collections"])) return hasPermission(user, "finance.view");
  if (matchesPrefix(pathname, ["/payroll"])) return canManagePayroll(user);

  if (matchesPrefix(pathname, ["/team"])) return hasPermission(user, "team.manage");
  if (matchesPrefix(pathname, ["/activity"])) return hasPermission(user, "activity.view");
  if (matchesPrefix(pathname, ["/vms-import"])) return canViewVmsImports(user);
  if (matchesPrefix(pathname, ["/vms-mappings"])) return canManageVmsMappings(user);
  if (matchesPrefix(pathname, ["/settings"])) return hasPermission(user, "system.settings");
  if (matchesPrefix(pathname, ["/admin"])) return hasPermission(user, "system.settings");

  return false;
}
