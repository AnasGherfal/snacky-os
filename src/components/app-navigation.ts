export type AppModuleKey =
  | "operations"
  | "cash"
  | "stock"
  | "machines"
  | "crm"
  | "finance"
  | "reports"
  | "admin";

export const appModuleLabels: Record<AppModuleKey, { en: string; ar: string }> = {
  operations: { en: "Operations", ar: "العمليات" },
  cash: { en: "Cash", ar: "النقدية" },
  stock: { en: "Stock & Purchasing", ar: "المخزون والمشتريات" },
  machines: { en: "Machines", ar: "الماكينات" },
  crm: { en: "Customer Relations", ar: "علاقات العملاء" },
  finance: { en: "Finance", ar: "المالية" },
  reports: { en: "Reports", ar: "التقارير" },
  admin: { en: "Admin", ar: "الإدارة" },
};

type AppModuleRule = { key: AppModuleKey; prefixes: string[]; };
function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// One module map for sidebar, top tabs and topbar. Specific routes precede broad ones.
const appModuleRules: AppModuleRule[] = [
  { key: "finance", prefixes: ["/admin/finance-health"] },
  { key: "crm", prefixes: ["/my-work", "/locations-pipeline", "/issues", "/relationships", "/contacts", "/follow-ups"] },
  { key: "cash", prefixes: ["/cash-collections"] },
  {
    key: "stock",
    prefixes: ["/inventory", "/product-planning", "/restock-priority", "/purchases", "/storage-locations", "/suppliers", "/products", "/warehouse"],
  },
  { key: "machines", prefixes: ["/machines", "/locations", "/machine-slots"] },
  { key: "operations", prefixes: ["/routes", "/refills"] },
  { key: "finance", prefixes: ["/finance", "/payroll"] },
  {
    key: "reports",
    prefixes: ["/reports", "/sales", "/products-dashboard", "/machines-dashboard", "/inventory-dashboard"],
  },
  {
    key: "admin",
    prefixes: ["/admin", "/team", "/settings", "/activity", "/vms-import", "/vms-mappings"],
  },
];

export function getAppModuleKey(pathname: string): AppModuleKey | null {
  for (const rule of appModuleRules) {
    if (rule.prefixes.some((prefix) => matchesPrefix(pathname, prefix))) return rule.key;
  }
  return null;
}
