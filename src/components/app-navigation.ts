export type AppModuleKey =
  | "operations"
  | "cash"
  | "stock"
  | "machines"
  | "crm"
  | "finance"
  | "reports"
  | "admin";

type AppModuleRule = {
  key: AppModuleKey;
  prefixes: string[];
};

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// Keep route ownership in one place so the sidebar and module tabs cannot drift.
// More-specific rules must come before broad prefixes such as /admin.
const appModuleRules: AppModuleRule[] = [
  { key: "finance", prefixes: ["/admin/finance-health"] },
  { key: "crm", prefixes: ["/locations-pipeline", "/issues"] },
  { key: "cash", prefixes: ["/cash-collections"] },
  {
    key: "stock",
    prefixes: [
      "/inventory",
      "/product-planning",
      "/restock-priority",
      "/purchases",
      "/storage-locations",
      "/suppliers",
      "/products",
      "/warehouse",
    ],
  },
  { key: "machines", prefixes: ["/machines", "/locations", "/machine-slots"] },
  { key: "operations", prefixes: ["/routes", "/refills"] },
  { key: "finance", prefixes: ["/finance", "/payroll"] },
  {
    key: "reports",
    prefixes: [
      "/reports",
      "/sales",
      "/products-dashboard",
      "/machines-dashboard",
      "/inventory-dashboard",
    ],
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
