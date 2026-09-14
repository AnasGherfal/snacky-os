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

const tab = (label: string, labelAr: string, href: string, options: Partial<ModuleTab> = {}): ModuleTab => ({ label, labelAr, href, ...options });
const section = (id: string, label: string, labelAr: string, tabs: ModuleTab[], options: Partial<NavigationSection> = {}): NavigationSection => ({ id, label, labelAr, tabs, ...options });

/** Each destination has ONE home, regardless of its incoming link, role, or query string.
 * Keep this registry free of React/browser dependencies: the sidebar, header, desktop
 * tabs, mobile selector, and regression tests all consume these same definitions. */
export const navigationModules: NavigationModule[] = [
  { id: "dashboard", name: "Dashboard", nameAr: "الرئيسية", sections: [
    section("overview", "Overview", "نظرة عامة", [tab("Dashboard", "الرئيسية", "/dashboard")]),
  ] },
  { id: "operations", name: "Operations", nameAr: "التشغيل", sections: [
    section("routes", "Routes & Refills", "الجولات والتعبئة", [
      tab("Routes", "الجولات", "/routes"),
      tab("Refill Recommendations", "توصيات التعبئة", "/refills"),
    ], { permission: "operations.manage" }),
    section("field", "Field Work", "العمل الميداني", [
      tab("My Routes", "جولاتي", "/operator/routes", { match: ["/operator"] }),
      tab("Available Routes", "الجولات المتاحة", "/operator/routes?view=available", { exact: true, query: { view: "available" } }),
      tab("My Issues", "بلاغاتي", "/operator/issues"),
    ], { routePerformerOnly: true }),
    section("recovery", "Recovery Tools", "معالجة التعثرات", [
      tab("Stop Override", "إنهاء محطة إدارياً", "/admin/stop-override"),
      tab("Historical Route Deduction", "تسجيل تعبئة سابقة", "/admin/historical-route-deduction"),
    ]),
  ] },
  { id: "crm", name: "CRM & Support", nameAr: "العلاقات وخدمة العملاء", sections: [
    section("leads", "Leads & Visits", "الجهات والزيارات", [tab("Leads & Visits", "الجهات والزيارات", "/locations-pipeline")]),
    section("support", "Customer Issues", "بلاغات العملاء", [tab("Customer Issues", "بلاغات العملاء", "/issues", { permission: "issues.view" })]),
  ] },
  { id: "machines", name: "Machines & Locations", nameAr: "الأجهزة والمواقع", sections: [
    section("machines", "Machines", "الأجهزة", [tab("Machines", "الأجهزة", "/machines")]),
    section("locations", "Locations", "المواقع", [tab("Locations", "المواقع", "/locations")]),
    section("health", "Setup & Maintenance", "الإعداد والصيانة", [
      tab("Planograms", "توزيع المنتجات", "/machine-slots"),
      tab("Status", "حالة الأجهزة", "/machines/status"),
      tab("Maintenance", "الصيانة", "/machines/maintenance"),
    ]),
  ] },
  { id: "inventory", name: "Inventory & Purchasing", nameAr: "المخزون والمشتريات", sections: [
    section("stock", "Stock", "المخزون", [
      tab("Storage", "مخزون المستودع", "/inventory"),
      tab("Stock Check", "الجرد", "/inventory/stock-check"),
      tab("Movements", "حركات المخزون", "/inventory/movements"),
      tab("Storage Locations", "أماكن التخزين", "/storage-locations"),
      tab("Pick Lists", "قوائم الاستلام", "/warehouse/pick-lists", { match: ["/warehouse"] }),
    ]),
    section("products", "Products", "المنتجات", [tab("Products", "المنتجات", "/products")]),
    section("purchasing", "Purchasing", "المشتريات", [
      tab("Purchases", "المشتريات", "/purchases"),
      tab("Suppliers", "الموردون", "/suppliers"),
    ]),
    section("planning", "Planning", "التخطيط", [
      tab("Product Planning", "تخطيط المنتجات", "/product-planning"),
      tab("Restock Priority", "أولوية إعادة التخزين", "/restock-priority"),
    ]),
  ] },
  { id: "cash", name: "Cash Custody", nameAr: "عهدة النقد", sections: [
    section("collections", "Collections", "التحصيل والعهدة", [tab("Cash Collections", "التحصيل والعهدة", "/cash-collections")]),
    section("removal", "Record Removal", "تسجيل سحب نقدية", [tab("Remove Cash", "تسجيل سحب نقدية", "/cash-collections/new")]),
  ] },
  { id: "finance", name: "Finance", nameAr: "المالية", sections: [
    section("overview", "Overview", "نظرة عامة", [tab("Overview", "نظرة عامة", "/finance")]),
    section("ledger", "Transactions", "المعاملات", [
      tab("Transactions", "المعاملات", "/finance/transactions"),
      tab("Expenses", "المصروفات", "/finance/expenses"),
    ]),
    section("planning", "Planning", "التخطيط المالي", [
      tab("Operations", "الأداء المالي", "/finance/operations"),
      tab("Growth Decisions", "قرارات النمو", "/finance/growth-decisions"),
      tab("Rent", "الإيجارات", "/finance/rent"),
      tab("Machine Investments", "استثمارات الأجهزة", "/finance/machine-investments"),
    ]),
    section("people", "People", "المستثمرون والرواتب", [
      tab("Investors", "المستثمرون", "/finance/investors"),
      tab("Payroll", "الرواتب", "/payroll"),
    ]),
    section("review", "Review & Import", "المراجعة والاستيراد", [
      tab("Import Review", "مراجعة الاستيراد", "/finance/import/review", { match: ["/finance/import"] }),
      tab("Cleanup", "تنظيم السجلات", "/finance/cleanup"),
      tab("Health", "سلامة السجلات المالية", "/admin/finance-health"),
    ]),
    section("reports", "Reports", "التقارير المالية", [tab("Reports", "التقارير المالية", "/finance/reports")]),
  ] },
  { id: "reports", name: "Reports", nameAr: "التقارير", sections: [
    section("overview", "Overview", "نظرة عامة", [tab("Overview", "نظرة عامة", "/reports")]),
    section("sales", "Sales", "المبيعات", [tab("Sales", "المبيعات", "/sales")]),
    section("operations", "Operations", "التشغيل", [
      tab("Monthly Operations", "التقرير التشغيلي الشهري", "/reports/route-performance"),
      tab("Product Activity", "نشاط المنتجات", "/reports/route-product-activity"),
    ]),
    section("analytics", "Products & Machines", "المنتجات والأجهزة", [
      tab("Products", "المنتجات", "/products-dashboard"),
      tab("Machines", "الأجهزة", "/machines-dashboard"),
      tab("Inventory", "المخزون", "/inventory-dashboard"),
    ]),
    section("cash", "Cash Reconciliation", "مطابقة النقدية", [tab("Cash Reconciliation", "مطابقة النقدية", "/reports/cash-reconciliation")]),
  ] },
  { id: "admin", name: "Administration", nameAr: "الإدارة", sections: [
    section("overview", "Overview", "نظرة عامة", [tab("Overview", "نظرة عامة", "/admin")]),
    section("team", "Team", "الفريق", [tab("Team", "الفريق", "/team")]),
    section("settings", "Settings", "الإعدادات", [tab("Settings", "الإعدادات", "/settings")]),
    section("activity", "Activity Log", "سجل النشاط", [tab("Activity Log", "سجل النشاط", "/activity")]),
    section("integrations", "Data & Integrations", "البيانات والربط", [
      tab("VMS Import", "استيراد بيانات الأجهزة", "/vms-import"),
      tab("VMS Data Sources", "مصادر بيانات الأجهزة", "/vms-import/sources"),
      tab("Monthly Profit Activation", "تفعيل الربح الشهري", "/vms-import/monthly-profit-repair"),
      tab("XY VMS API", "ربط نظام XY", "/admin/vms-api"),
      tab("Product Mapping", "مطابقة المنتجات", "/vms-mappings"),
    ]),
    section("tools", "System Tools", "أدوات النظام", [
      tab("System Health", "سلامة النظام", "/admin/system-health"),
      tab("Diagnostics", "التشخيص", "/admin/diagnostics"),
      tab("Tools", "أدوات الصيانة", "/admin/tools"),
      tab("KPI Definitions", "تعريف المؤشرات", "/admin/kpi-definitions"),
      tab("Refill Diagnostics", "تشخيص توصيات التعبئة", "/admin/route-recommendation-debug"),
    ]),
  ] },
  { id: "investor", name: "Investor Portal", nameAr: "بوابة المستثمر", sections: [
    section("overview", "Overview", "نظرة عامة", [tab("Investor Portal", "بوابة المستثمر", "/investor")]),
  ] },
  { id: "account", name: "My Account", nameAr: "حسابي", utility: true, sections: [
    section("account", "Account", "الحساب", [tab("Account", "الحساب", "/account")]),
    section("install", "Install App", "تثبيت التطبيق", [tab("Install App", "تثبيت التطبيق", "/install")]),
  ] },
];

export function pathnameFromHref(href: string) {
  const path = href.split(/[?#]/)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** More-specific paths beat generic parents; query tabs beat the same path only.
 * A filter, pagination parameter, or legacy ?module=finance never changes ownership. */
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
        tab("My Profile", "ملفي", `/team/${encodeURIComponent(user.teamMemberId)}`, { exact: true }),
        tab("My Money", "حسابي المالي", `/team/${encodeURIComponent(user.teamMemberId)}/money`),
      ]), ...sections.slice(1)];
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
    // Finance/purchasing users must not land on a forbidden stock screen.
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

/** Compatibility export for callers that need a flat list, not a second registry. */
export function getModuleTabGroupForPath(pathname: string, _legacyModuleParam?: string | null): ModuleTabGroup | null {
  const location = resolveNavigation(pathname);
  if (!location) return null;
  return { name: location.module.name, nameAr: location.module.nameAr, tabs: location.module.sections.flatMap((group) => group.tabs) };
}
