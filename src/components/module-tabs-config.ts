import type { ModuleTab } from "@/components/ModuleTabs";

export type ModuleTabGroup = {
  name: string;
  tabs: ModuleTab[];
};

const financeTabs: ModuleTab[] = [
  { label: "Overview", href: "/finance", exact: true },
  { label: "Transactions", href: "/finance/transactions" },
  { label: "Cash Collections", href: "/cash-collections" },
  { label: "Purchases", href: "/purchases?module=finance", match: ["/purchases"] },
  { label: "Expenses", href: "/finance/expenses" },
  { label: "Rent", href: "/finance/rent" },
  { label: "Machine Investments", href: "/finance/machine-investments" },
  { label: "Reports", href: "/finance/reports" },
];

const inventoryTabs: ModuleTab[] = [
  { label: "Storage", href: "/inventory", exact: true },
  { label: "Restock Priority", href: "/restock-priority" },
  { label: "Movements", href: "/inventory/movements" },
  { label: "Purchases", href: "/purchases", match: ["/purchases"] },
  { label: "Storage Locations", href: "/storage-locations" },
  { label: "Suppliers", href: "/suppliers" },
  { label: "Products", href: "/products" },
];

const machinesTabs: ModuleTab[] = [
  { label: "Machines", href: "/machines", exact: true },
  { label: "Planograms", href: "/machine-slots" },
  { label: "Status", href: "/machines/status" },
  { label: "Issues", href: "/issues" },
  { label: "Maintenance", href: "/machines/maintenance" },
];

const adminTabs: ModuleTab[] = [
  { label: "Overview", href: "/admin", exact: true },
  { label: "Team", href: "/team" },
  { label: "Settings", href: "/settings" },
  { label: "Activity Log", href: "/activity" },
  { label: "VMS Import", href: "/vms-import" },
  { label: "XY VMS API", href: "/admin/vms-api" },
  { label: "Product Mapping", href: "/vms-mappings" },
];

const reportsTabs: ModuleTab[] = [
  { label: "Overview", href: "/reports", exact: true },
  { label: "Sales", href: "/sales" },
  { label: "Products", href: "/products-dashboard" },
  { label: "Machines", href: "/machines-dashboard" },
  { label: "Inventory", href: "/inventory-dashboard" },
];

const groups = {
  finance: { name: "Finance", tabs: financeTabs },
  inventory: { name: "Inventory", tabs: inventoryTabs },
  machines: { name: "Machines", tabs: machinesTabs },
  admin: { name: "Admin", tabs: adminTabs },
  reports: { name: "Reports", tabs: reportsTabs },
} satisfies Record<string, ModuleTabGroup>;

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPurchasesPath(pathname: string) {
  return matchesPrefix(pathname, "/purchases");
}

export function pathnameFromHref(href: string) {
  return href.split("?")[0]?.split("#")[0] || href;
}

export function getModuleTabGroupForPath(pathname: string, moduleParam?: string | null): ModuleTabGroup | null {
  if (isPurchasesPath(pathname)) {
    return moduleParam === "finance" ? groups.finance : groups.inventory;
  }

  if (matchesPrefix(pathname, "/finance") || matchesPrefix(pathname, "/cash-collections")) return groups.finance;
  if (
    matchesPrefix(pathname, "/inventory") ||
    matchesPrefix(pathname, "/restock-priority") ||
    matchesPrefix(pathname, "/storage-locations") ||
    matchesPrefix(pathname, "/suppliers") ||
    matchesPrefix(pathname, "/products")
  ) {
    return groups.inventory;
  }
  if (matchesPrefix(pathname, "/machines") || matchesPrefix(pathname, "/machine-slots") || matchesPrefix(pathname, "/issues")) {
    return groups.machines;
  }
  if (
    matchesPrefix(pathname, "/admin") ||
    matchesPrefix(pathname, "/team") ||
    matchesPrefix(pathname, "/settings") ||
    matchesPrefix(pathname, "/activity") ||
    matchesPrefix(pathname, "/vms-import") ||
    matchesPrefix(pathname, "/vms-mappings")
  ) {
    return groups.admin;
  }
  if (
    matchesPrefix(pathname, "/reports") ||
    matchesPrefix(pathname, "/sales") ||
    matchesPrefix(pathname, "/products-dashboard") ||
    matchesPrefix(pathname, "/machines-dashboard") ||
    matchesPrefix(pathname, "/inventory-dashboard")
  ) {
    return groups.reports;
  }

  return null;
}
