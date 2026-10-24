import { canAccessPath, isOwnerAdminRole, isSupervisorRole, type AppRole } from "@/lib/authz";

export type MobileRoleProfile = {
  id: string;
  role: AppRole;
  roles?: AppRole[] | null;
  active_status: "active" | "inactive";
  can_add_products?: boolean | null;
  team_member_id?: string | null;
};
export type MobileShortcut = {
  href: string;
  en: string;
  ar: string;
  icon: "house" | "route" | "warehouse" | "machines" | "work" | "issues" | "leads" | "sites"
      | "available" | "cash" | "buying" | "finance" | "account" | "pick" | "products";
  module?: "operations" | "stock" | "machines" | "crm" | "cash" | "finance" | "reports";
};

const management: MobileShortcut[] = [
  { href: "/dashboard", en: "Home", ar: "الرئيسية", icon: "house" },
  { href: "/routes", en: "Routes", ar: "الجولات", icon: "route", module: "operations" },
  { href: "/inventory", en: "Stock", ar: "المخزون", icon: "warehouse", module: "stock" },
  { href: "/machines", en: "Machines", ar: "الماكينات", icon: "machines", module: "machines" },
];
const customerRelations: MobileShortcut[] = [
  { href: "/my-work", en: "My Work", ar: "عملي", icon: "work" },
  { href: "/issues", en: "Issues", ar: "البلاغات", icon: "issues" },
  { href: "/locations-pipeline", en: "Leads", ar: "الجهات", icon: "leads" },
  { href: "/relationships", en: "Sites", ar: "المواقع", icon: "sites" },
];
const operator: MobileShortcut[] = [
  { href: "/operator/routes", en: "My Routes", ar: "جولاتي", icon: "route" },
  { href: "/operator/routes?view=available", en: "Available", ar: "المتاحة", icon: "available" },
  { href: "/operator/issues", en: "Issues", ar: "البلاغات", icon: "issues" },
  { href: "/cash-handling", en: "Cash", ar: "النقدية", icon: "cash" },
];
const warehouse: MobileShortcut[] = [
  { href: "/my-day", en: "My Work", ar: "مهامي", icon: "work" },
  { href: "/warehouse/pick-lists", en: "Pick Lists", ar: "التجهيز", icon: "pick" },
  { href: "/inventory", en: "Storage", ar: "المخزن", icon: "warehouse", module: "stock" },
  { href: "/buying-lists", en: "Buying", ar: "الشراء", icon: "buying" },
];
const purchasing: MobileShortcut[] = [
  { href: "/my-day", en: "My Work", ar: "مهامي", icon: "work" },
  { href: "/buying-lists", en: "Buying", ar: "الشراء", icon: "buying" },
  { href: "/purchases", en: "Purchases", ar: "المشتريات", icon: "buying" },
  { href: "/products", en: "Products", ar: "المنتجات", icon: "products" },
];
const finance: MobileShortcut[] = [
  { href: "/finance", en: "Finance", ar: "المالية", icon: "finance" },
  { href: "/finance/transactions", en: "Ledger", ar: "المعاملات", icon: "work" },
  { href: "/cash-handling", en: "Cash", ar: "النقدية", icon: "cash" },
  { href: "/buying-lists", en: "Buying", ar: "الشراء", icon: "buying" },
];
const investor: MobileShortcut[] = [
  { href: "/investor", en: "Investor", ar: "المستثمر", icon: "finance" },
  { href: "/account", en: "Account", ar: "حسابي", icon: "account" },
];
const viewer: MobileShortcut[] = [
  { href: "/dashboard", en: "Home", ar: "الرئيسية", icon: "house" },
  { href: "/account", en: "Account", ar: "حسابي", icon: "account" },
];

export function mobileRoleKind(profile: MobileRoleProfile): AppRole {
  if (isOwnerAdminRole(profile)) return "owner";
  if (isSupervisorRole(profile)) return "supervisor";
  return profile.role;
}

/** Read-only navigation; final authorization is enforced by each page/API. */
export function getRoleMobileDestinations(profile: MobileRoleProfile): MobileShortcut[] {
  if (profile.active_status !== "active") return [];
  const mode = mobileRoleKind(profile);
  const candidates = mode === "owner" || mode === "admin" || mode === "supervisor" ? management
    : mode === "crm" ? customerRelations
    : mode === "operator" ? operator
    : mode === "warehouse" ? warehouse
    : mode === "purchasing" ? purchasing
    : mode === "finance" ? finance
    : mode === "investor" ? investor : viewer;
  const context = {
    id: profile.id, role: profile.role, roles: profile.roles,
    canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  };
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const path = item.href.split("?")[0];
    if (!canAccessPath(context, path) || seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  }).slice(0, 4);
}

export function showRoleMobileNavigation(profile: MobileRoleProfile, pathname: string): boolean {
  if (profile.active_status !== "active") return false;
  // Route-stop execution uses its own phone controls. Never cover Complete Stop.
  if (pathname.startsWith("/operator/routes/")) return false;
  return getRoleMobileDestinations(profile).length > 0;
}

/** One selected shortcut; precise URLs beat module-wide fallbacks. */
export function activeMobileShortcutIndex(
  items: readonly MobileShortcut[], pathname: string, query: string,
  moduleKey: string | null,
): number {
  const search = new URLSearchParams(query);
  let winningIndex = -1;
  let winningScore = -1;
  items.forEach((item, index) => {
    const [path, params] = item.href.split("?");
    const expectedQuery = new URLSearchParams(params ?? "");
    const requiresView = expectedQuery.has("view");
    if (requiresView && search.get("view") !== expectedQuery.get("view")) return;
    if (!requiresView && pathname === path && items.some((other) =>
      other.href.startsWith(path + "?view=") &&
      new URLSearchParams(other.href.split("?")[1]).get("view") === search.get("view")
    )) return;
    const exact = pathname === path;
    const prefix = pathname.startsWith(path + "/");
    const viaModule = item.module && moduleKey === item.module;
    if (!exact && !prefix && !viaModule) return;
    const score = exact ? 10000 + path.length : prefix ? 1000 + path.length : 1;
    if (score > winningScore) { winningScore = score; winningIndex = index; }
  });
  return winningIndex;
}
