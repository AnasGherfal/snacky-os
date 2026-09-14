import { canAccessPath, canExecuteRoutes, hasPermission, hasRole, type AppPermission, type AuthUserContext } from "../lib/authz.ts";

export type ModuleTab = {
  label: string;
  labelAr?: string;
  href: string;
  exact?: boolean;
  match?: string[];
  query?: Record<string, string>;
  permission?: AppPermission;
};
export type NavigationSection = {
  id: string;
  label: string;
  labelAr: string;
  tabs: ModuleTab[];
  permission?: AppPermission;
  routePerformerOnly?: boolean;
};
export type NavigationModuleId = "dashboard" | "operations" | "inventory" | "machines" | "crm" | "cash" | "finance" | "reports" | "admin" | "investor" | "account";
export type NavigationModule = {
  id: NavigationModuleId;
  name: string;
  nameAr: string;
  sections: NavigationSection[];
  utility?: boolean;
  href?: string;
};
export type NavigationLocation = { module: NavigationModule; section: NavigationSection; tab: ModuleTab };
export type ModuleTabGroup = { name: string; nameAr: string; tabs: ModuleTab[] };

const section = (id: string, label: string, labelAr: string, tabs: ModuleTab[], options: Partial<NavigationSection> = {}): NavigationSection => ({ id, label, labelAr, tabs, ...options });

/** One home per destination. All shell surfaces consume this same pure registry.
 * A query filter or the incoming page never changes the destination's workspace. */
export const navigationModules: NavigationModule[] = [
  { id: "dashboard", name: "Dashboard", nameAr: "الرئيسية", sections: [
    section("overview", "Overview", "نظرة عامة", [{ label: "Dashboard", href: "/dashboard", labelAr: "الرئيسية" }]),
  ] },
  { id: "operations", name: "Operations", nameAr: "التشغيل", sections: [
    section("routes", "Routes & Refills", "الجولات والتعبئة", [
      { label: "Routes", href: "/routes", labelAr: "الجولات" },
      { label: "Refill Recommendations", href: "/refills", labelAr: "توصيات التعبئة" },
    ], { permission: "operations.manage" }),
    section("field", "Field Work", "العمل الميداني", [
      { label: "My Routes", href: "/operator/routes", labelAr: "جولاتي", match: ["/operator"] },
      { label: "Available Routes", href: "/operator/routes?view=available", labelAr: "الجولات المتاحة", exact: true, query: { view: "available" } },
      { label: "My Issues", href: "/operator/issues", labelAr: "بلاغاتي" },
    ], { routePerformerOnly: true }),
    section("recovery", "Recovery Tools", "معالجة التعثرات", [
      { label: "Stop Override", href: "/admin/stop-override", labelAr: "إنهاء محطة إدارياً" },
      { label: "Historical Route Deduction", href: "/admin/historical-route-deduction", labelAr: "تسجيل تعبئة سابقة" },
    ]),
  ] },
  { id: "crm", name: "CRM & Support", nameAr: "العلاقات وخدمة العملاء", sections: [
    section("leads", "Leads & Visits", "الجهات والزيارات", [{ label: "Leads & Visits", href: "/locations-pipeline", labelAr: "الجهات والزيارات" }]),
    section("support", "Customer Issues", "بلاغات العملاء", [{ label: "Customer Issues", href: "/issues", labelAr: "بلاغات العملاء", permission: "issues.view" }]),
  ] },
  { id: "machines", name: "Machines & Locations", nameAr: "الأجهزة والمواقع", sections: [
    section("machines", "Machines", "الأجهزة", [{ label: "Machines", href: "/machines", labelAr: "الأجهزة" }]),
    section("locations", "Locations", "المواقع", [{ label: "Locations", href: "/locations", labelAr: "المواقع" }]),
    section("health", "Setup & Maintenance", "الإعداد والصيانة", [
      { label: "Planograms", href: "/machine-slots", labelAr: "توزيع المنتجات" },
      { label: "Status", href: "/machines/status", labelAr: "حالة الأجهزة" },
      { label: "Maintenance", href: "/machines/maintenance", labelAr: "الصيانة" },
    ]),
  ] },
  { id: "inventory", name: "Inventory & Purchasing", nameAr: "المخزون والمشتريات", sections: [
    section("stock", "Stock", "المخزون", [
      { label: "Storage", href: "/inventory", labelAr: "مخزون المستودع" },
      { label: "Stock Check", href: "/inventory/stock-check", labelAr: "الجرد" },
      { label: "Movements", href: "/inventory/movements", labelAr: "حركات المخزون" },
      { label: "Storage Locations", href: "/storage-locations", labelAr: "أماكن التخزين" },
      { label: "Pick Lists", href: "/warehouse/pick-lists", labelAr: "قوائم الاستلام", match: ["/warehouse"] },
    ]),
    section("products", "Products", "المنتجات", [{ label: "Products", href: "/products", labelAr: "المنتجات" }]),
    section("purchasing", "Purchasing", "المشتريات", [
      { label: "Purchases", href: "/purchases", labelAr: "المشتريات" },
      { label: "Suppliers", href: "/suppliers", labelAr: "الموردون" },
    ]),
    section("planning", "Planning", "التخطيط", [
      { label: "Product Planning", href: "/product-planning", labelAr: "تخطيط المنتجات" },
      { label: "Restock Priority", href: "/restock-priority", labelAr: "أولوية إعادة التخزين" },
    ]),
  ] },
  { id: "cash", name: "Cash Custody", nameAr: "عهدة النقد", sections: [
    section("collections", "Collections", "التحصيل والعهدة", [{ label: "Cash Collections", href: "/cash-collections", labelAr: "التحصيل والعهدة" }]),
    section("removal", "Record Removal", "تسجيل سحب نقدية", [{ label: "Remove Cash", href: "/cash-collections/new", labelAr: "تسجيل سحب نقدية" }]),
  ] },
  { id: "finance", name: "Finance", nameAr: "المالية", sections: [
    section("overview", "Overview", "نظرة عامة", [{ label: "Overview", href: "/finance", labelAr: "نظرة عامة" }]),
    section("ledger", "Transactions", "المعاملات", [
      { label: "Transactions", href: "/finance/transactions", labelAr: "المعاملات" },
      { label: "Expenses", href: "/finance/expenses", labelAr: "المصروفات" },
    ]),
    section("planning", "Planning", "التخطيط المالي", [
      { label: "Operations", href: "/finance/operations", labelAr: "الأداء المالي" },
      { label: "Growth Decisions", href: "/finance/growth-decisions", labelAr: "قرارات النمو" },
      { label: "Rent", href: "/finance/rent", labelAr: "الإيجارات" },
      { label: "Machine Investments", href: "/finance/machine-investments", labelAr: "استثمارات الأجهزة" },
    ]),
    section("people", "People", "المستثمرون والرواتب", [
      { label: "Investors", href: "/finance/investors", labelAr: "المستثمرون" },
      { label: "Payroll", href: "/payroll", labelAr: "الرواتب" },
    ]),
    section("review", "Review & Import", "المراجعة والاستيراد", [
      { label: "Import Review", href: "/finance/import/review", labelAr: "مراجعة الاستيراد", match: ["/finance/import"] },
      { label: "Cleanup", href: "/finance/cleanup", labelAr: "تنظيم السجلات" },
      { label: "Health", href: "/admin/finance-health", labelAr: "سلامة السجلات المالية" },
    ]),
    section("reports", "Reports", "التقارير المالية", [{ label: "Reports", href: "/finance/reports", labelAr: "التقارير المالية" }]),
  ] },
  { id: "reports", name: "Reports", nameAr: "التقارير", sections: [
    section("overview", "Overview", "نظرة عامة", [{ label: "Overview", href: "/reports", labelAr: "نظرة عامة" }]),
    section("sales", "Sales", "المبيعات", [{ label: "Sales", href: "/sales", labelAr: "المبيعات" }]),
    section("operations", "Operations", "التشغيل", [
      { label: "Monthly Operations", href: "/reports/route-performance", labelAr: "التقرير التشغيلي الشهري" },
      { label: "Product Activity", href: "/reports/route-product-activity", labelAr: "نشاط المنتجات" },
    ]),
    section("analytics", "Products & Machines", "المنتجات والأجهزة", [
      { label: "Products", href: "/products-dashboard", labelAr: "المنتجات" },
      { label: "Machines", href: "/machines-dashboard", labelAr: "الأجهزة" },
      { label: "Inventory", href: "/inventory-dashboard", labelAr: "المخزون" },
    ]),
    section("cash", "Cash Reconciliation", "مطابقة النقدية", [{ label: "Cash Reconciliation", href: "/reports/cash-reconciliation", labelAr: "مطابقة النقدية" }]),
  ] },
  { id: "admin", name: "Administration", nameAr: "الإدارة", sections: [
    section("overview", "Overview", "نظرة عامة", [{ label: "Overview", href: "/admin", labelAr: "نظرة عامة" }]),
    section("team", "Team", "الفريق", [{ label: "Team", href: "/team", labelAr: "الفريق" }]),
    section("settings", "Settings", "الإعدادات", [{ label: "Settings", href: "/settings", labelAr: "الإعدادات" }]),
    section("activity", "Activity Log", "سجل النشاط", [{ label: "Activity Log", href: "/activity", labelAr: "سجل النشاط" }]),
    section("integrations", "Data & Integrations", "البيانات والربط", [
      { label: "VMS Import", href: "/vms-import", labelAr: "استيراد بيانات الأجهزة" },
      { label: "VMS Data Sources", href: "/vms-import/sources", labelAr: "مصادر بيانات الأجهزة" },
      { label: "Monthly Profit Activation", href: "/vms-import/monthly-profit-repair", labelAr: "تفعيل الربح الشهري" },
      { label: "XY VMS API", href: "/admin/vms-api", labelAr: "ربط نظام XY" },
      { label: "Product Mapping", href: "/vms-mappings", labelAr: "مطابقة المنتجات" },
    ]),
    section("tools", "System Tools", "أدوات النظام", [
      { label: "System Health", href: "/admin/system-health", labelAr: "سلامة النظام" },
      { label: "Diagnostics", href: "/admin/diagnostics", labelAr: "التشخيص" },
      { label: "Tools", href: "/admin/tools", labelAr: "أدوات الصيانة" },
      { label: "KPI Definitions", href: "/admin/kpi-definitions", labelAr: "تعريف المؤشرات" },
      { label: "Refill Diagnostics", href: "/admin/route-recommendation-debug", labelAr: "تشخيص توصيات التعبئة" },
    ]),
  ] },
  { id: "investor", name: "Investor Portal", nameAr: "بوابة المستثمر", sections: [
    section("overview", "Overview", "نظرة عامة", [{ label: "Investor Portal", href: "/investor", labelAr: "بوابة المستثمر" }]),
  ] },
  { id: "account", name: "My Account", nameAr: "حسابي", utility: true, sections: [
    section("account", "Account", "الحساب", [{ label: "Account", href: "/account", labelAr: "الحساب" }]),
    section("install", "Install App", "تثبيت التطبيق", [{ label: "Install App", href: "/install", labelAr: "تثبيت التطبيق" }]),
  ] },
];

export function pathnameFromHref(href: string) {
  const path = href.split(/[?#]/)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Most-specific path wins; only a matching query can activate a query-specific tab. */
export function tabMatchScore(pathname: string, item: ModuleTab, currentSearch = "") {
  const path = pathnameFromHref(pathname);
  const search = new URLSearchParams(currentSearch || pathname.split("?")[1]?.split("#")[0] || "");
  const expectedQuery = item.query ?? Object.fromEntries(new URLSearchParams(item.href.split("?")[1]?.split("#")[0] || ""));
  if (Object.entries(expectedQuery).some(([key, value]) => search.get(key) !== value)) return -1;
  let specificity = -1;
  for (const candidate of [item.href, ...(item.match ?? [])].map(pathnameFromHref)) {
    if (path === candidate || (!item.exact && path.startsWith(`${candidate}/`))) specificity = Math.max(specificity, candidate.length);
  }
  return specificity < 0 ? -1 : specificity * 100 + Object.keys(expectedQuery).length;
}

export function activeTabForPath(tabs: ModuleTab[], pathname: string, currentSearch = "") {
  let best: ModuleTab | null = null;
  let score = -1;
  for (const item of tabs) {
    const candidateScore = tabMatchScore(pathname, item, currentSearch);
    if (candidateScore > score) { best = item; score = candidateScore; }
  }
  return best;
}

export function navigationForUser(user: AuthUserContext | null | undefined): NavigationModule[] {
  if (!user || user.activeStatus === "inactive") return [];
  const modules = navigationModules.map((module) => {
    let sections = module.sections;
    if (module.id === "account" && user.teamMemberId && !hasPermission(user, "team.manage")) {
      sections = [sections[0], section("profile", "My Profile", "ملفي", [
        { label: "My Profile", href: `/team/${encodeURIComponent(user.teamMemberId)}`, labelAr: "ملفي", exact: true },
        { label: "My Money", href: `/team/${encodeURIComponent(user.teamMemberId)}/money`, labelAr: "حسابي المالي" },
      ]), ...sections.slice(1)];
    }
    if (module.id === "inventory" && !canAccessPath(user, "/products") && canAccessPath(user, "/products/new")) {
      sections = sections.map((group) => group.id === "products" ? { ...group, tabs: [{ label: "Add Product", href: "/products/new", labelAr: "إضافة منتج" }] } : group);
    }
    return {
      ...module,
      sections: sections.filter((group) => (!group.permission || hasPermission(user, group.permission)) && (!group.routePerformerOnly || canExecuteRoutes(user)))
        .map((group) => ({ ...group, tabs: group.tabs.filter((item) => (!item.permission || hasPermission(user, item.permission)) && canAccessPath(user, pathnameFromHref(item.href))) }))
        .filter((group) => group.tabs.length > 0),
    };
  }).filter((module) => module.sections.length > 0 && (module.id !== "investor" || hasRole(user, "investor")));

  return modules.map((module) => {
    const tabs = module.sections.flatMap((group) => group.tabs);
    const purchasingLanding = module.id === "inventory" && !hasPermission(user, "storage.view") && tabs.find((item) => item.href === "/purchases");
    return { ...module, href: purchasingLanding ? purchasingLanding.href : tabs[0].href };
  });
}

export function resolveNavigation(pathname: string, currentSearch = "", modules: NavigationModule[] = navigationModules): NavigationLocation | null {
  let best: NavigationLocation | null = null;
  let score = -1;
  for (const module of modules) for (const group of module.sections) for (const item of group.tabs) {
    const candidateScore = tabMatchScore(pathname, item, currentSearch);
    if (candidateScore > score) { best = { module, section: group, tab: item }; score = candidateScore; }
  }
  return best;
}

/** A user may open an individual receipt without permission to list all receipts.
 * Preserve that record's workspace, but never expose its forbidden parent index. */
export function navigationContextForUser(user: AuthUserContext, pathname: string, currentSearch = "") {
  const modules = navigationForUser(user);
  const path = pathnameFromHref(pathname);
  if (!canAccessPath(user, path)) return { modules, location: null };
  const visible = resolveNavigation(pathname, currentSearch, modules);
  const canonical = resolveNavigation(pathname, currentSearch);
  if (visible && (!canonical || visible.module.id === "account" || visible.tab.href === canonical.tab.href || tabMatchScore(pathname, visible.tab, currentSearch) >= tabMatchScore(pathname, canonical.tab, currentSearch))) {
    return { modules, location: visible };
  }
  if (!canonical) return { modules, location: visible };
  const existingModule = modules.find((module) => module.id === canonical.module.id);
  const recordTab: ModuleTab = { label: "Current record", href: path, labelAr: "السجل الحالي", exact: true };
  const existingSection = existingModule?.sections.find((group) => group.id === canonical.section.id);
  const recordSection: NavigationSection = { ...canonical.section, tabs: [...(existingSection?.tabs ?? []), recordTab] };
  const recordModule: NavigationModule = existingModule
    ? { ...existingModule, sections: existingSection ? existingModule.sections.map((group) => group.id === recordSection.id ? recordSection : group) : [...existingModule.sections, recordSection] }
    : { ...canonical.module, href: path, sections: [recordSection] };
  return {
    modules: existingModule ? modules.map((module) => module.id === recordModule.id ? recordModule : module) : [...modules, recordModule],
    location: { module: recordModule, section: recordSection, tab: recordTab },
  };
}

/** Legacy callers receive the same registry, not a competing navigation system. */
export function getModuleTabGroupForPath(pathname: string, _legacyModuleParam?: string | null): ModuleTabGroup | null {
  const location = resolveNavigation(pathname);
  return location ? { name: location.module.name, nameAr: location.module.nameAr, tabs: location.module.sections.flatMap((group) => group.tabs) } : null;
}
