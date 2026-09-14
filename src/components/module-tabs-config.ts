import type { ModuleTab } from "@/components/ModuleTabs";
import { getAppModuleKey, type AppModuleKey } from "@/components/app-navigation";

export type ModuleTabGroup = {
  name: string;
  nameAr: string;
  tabs: ModuleTab[];
};

const operationsTabs: ModuleTab[] = [
  { label: "Routes", labelAr: "المسارات", href: "/routes" },
  { label: "New Route", labelAr: "مسار جديد", href: "/routes/new" },
  { label: "Refills", labelAr: "التعبئة", href: "/refills" },
];

const cashTabs: ModuleTab[] = [
  { label: "Cash Collections", labelAr: "تحصيل النقدية", href: "/cash-collections" },
  { label: "Remove Cash", labelAr: "سحب النقد", href: "/cash-collections/new" },
];

const stockTabs: ModuleTab[] = [
  { label: "Storage", labelAr: "المخزون", href: "/inventory", exact: true },
  { label: "Stock Check", labelAr: "جرد المخزون", href: "/inventory/stock-check" },
  { label: "Restock Priority", labelAr: "أولوية التزويد", href: "/restock-priority" },
  { label: "Purchases", labelAr: "المشتريات", href: "/purchases" },
  { label: "Products", labelAr: "المنتجات", href: "/products" },
  { label: "Suppliers", labelAr: "الموردون", href: "/suppliers" },
  { label: "Storage Locations", labelAr: "مواقع التخزين", href: "/storage-locations" },
  { label: "Movements", labelAr: "حركة المخزون", href: "/inventory/movements" },
  { label: "Product Planning", labelAr: "تخطيط المنتجات", href: "/product-planning" },
];

const machinesTabs: ModuleTab[] = [
  { label: "Machines", labelAr: "الماكينات", href: "/machines", exact: true },
  { label: "Locations", labelAr: "المواقع", href: "/locations" },
  { label: "Planograms", labelAr: "توزيع المنتجات", href: "/machine-slots" },
  { label: "Status", labelAr: "الحالة", href: "/machines/status" },
  { label: "Maintenance", labelAr: "الصيانة", href: "/machines/maintenance" },
];

const crmTabs: ModuleTab[] = [
  { label: "Leads & Visits", labelAr: "الجهات والزيارات", href: "/locations-pipeline" },
  { label: "Customer Issues", labelAr: "مشاكل العملاء", href: "/issues" },
];

const financeTabs: ModuleTab[] = [
  { label: "Overview", labelAr: "نظرة عامة", href: "/finance", exact: true },
  { label: "Operations", labelAr: "العمليات", href: "/finance/operations" },
  { label: "Growth Decisions", labelAr: "قرارات النمو", href: "/finance/growth-decisions" },
  { label: "Investors", labelAr: "المستثمرون", href: "/finance/investors" },
  { label: "Payroll", labelAr: "المرتبات", href: "/payroll" },
  { label: "Transactions", labelAr: "المعاملات", href: "/finance/transactions" },
  { label: "Import Review", labelAr: "مراجعة الاستيراد", href: "/finance/import/review", match: ["/finance/import"] },
  { label: "Cleanup", labelAr: "التنظيف", href: "/finance/cleanup" },
  { label: "Expenses", labelAr: "المصروفات", href: "/finance/expenses" },
  { label: "Rent", labelAr: "الإيجارات", href: "/finance/rent" },
  { label: "Machine Investments", labelAr: "استثمارات الماكينات", href: "/finance/machine-investments" },
  { label: "Reports", labelAr: "التقارير", href: "/finance/reports" },
  { label: "Health", labelAr: "سلامة النظام", href: "/admin/finance-health" },
];

const adminTabs: ModuleTab[] = [
  { label: "Overview", labelAr: "نظرة عامة", href: "/admin", exact: true },
  { label: "Stop Override", labelAr: "تجاوز نقطة التوقف", href: "/admin/stop-override" },
  { label: "Team", labelAr: "الفريق", href: "/team" },
  { label: "Settings", labelAr: "الإعدادات", href: "/settings" },
  { label: "Activity Log", labelAr: "سجل النشاط", href: "/activity" },
  { label: "VMS Import", labelAr: "استيراد VMS", href: "/vms-import" },
  { label: "Monthly Profit Activation", labelAr: "تفعيل الربح الشهري", href: "/vms-import/monthly-profit-repair" },
  { label: "VMS Data Sources", labelAr: "مصادر بيانات VMS", href: "/vms-import/sources" },
  { label: "XY VMS API", labelAr: "واجهة XY VMS", href: "/admin/vms-api" },
  { label: "Product Mapping", labelAr: "مطابقة المنتجات", href: "/vms-mappings" },
];

const reportsTabs: ModuleTab[] = [
  { label: "Overview", href: "/reports", labelAr: "نظرة عامة", exact: true },
  { label: "Sales", href: "/sales", labelAr: "المبيعات" },
  { label: "Cash Reconciliation", href: "/reports/cash-reconciliation", labelAr: "مطابقة النقدية" },
  { label: "Monthly Operations", href: "/reports/route-performance", labelAr: "التقرير التشغيلي الشهري" },
  { label: "Product Activity", href: "/reports/route-product-activity", labelAr: "نشاط المنتجات" },
  { label: "Products", href: "/products-dashboard", labelAr: "المنتجات" },
  { label: "Machines", href: "/machines-dashboard", labelAr: "الأجهزة" },
  { label: "Inventory", href: "/inventory-dashboard", labelAr: "المخزون" },
];

const groups: Record<AppModuleKey, ModuleTabGroup> = {
  operations: { name: "Operations", nameAr: "العمليات", tabs: operationsTabs },
  cash: { name: "Cash", nameAr: "النقدية", tabs: cashTabs },
  stock: { name: "Stock & Purchasing", nameAr: "المخزون والمشتريات", tabs: stockTabs },
  machines: { name: "Machines", nameAr: "الماكينات", tabs: machinesTabs },
  crm: { name: "CRM", nameAr: "العملاء والجهات", tabs: crmTabs },
  finance: { name: "Finance", nameAr: "المالية", tabs: financeTabs },
  reports: { name: "Reports", nameAr: "التقارير", tabs: reportsTabs },
  admin: { name: "Admin", nameAr: "الإدارة", tabs: adminTabs },
};

export function pathnameFromHref(href: string) {
  return href.split("?")[0]?.split("#")[0] || href;
}

export function getModuleTabGroupForPath(pathname: string): ModuleTabGroup | null {
  const key = getAppModuleKey(pathname);
  return key ? groups[key] : null;
}
