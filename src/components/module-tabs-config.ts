import type { ModuleTab } from "@/components/ModuleTabs";
import { getAppModuleKey, type AppModuleKey } from "@/components/app-navigation";

export type ModuleTabGroup = { name: string; nameAr: string; tabs: ModuleTab[]; };
const operationsTabs: ModuleTab[] = [
  { label: "Routes", href: "/routes", labelAr: "المسارات" },
  { label: "New Route", href: "/routes/new", labelAr: "مسار جديد" },
  { label: "Refills", href: "/refills", labelAr: "التعبئة" },
];
const cashTabs: ModuleTab[] = [
  { label: "Cash Collections", href: "/cash-collections", labelAr: "تحصيل النقدية" },
  { label: "Remove Cash", href: "/cash-collections/new", labelAr: "سحب النقد" },
  { label: "Cash Handling", href: "/cash-handling", labelAr: "تسليم وعد النقد" },
];
const stockTabs: ModuleTab[] = [
  { label: "Storage", href: "/inventory", labelAr: "المخزون", exact: true },
  { label: "Restock Priority", href: "/restock-priority", labelAr: "أولوية التزويد" },
  { label: "Purchases", href: "/purchases", labelAr: "المشتريات" },
  { label: "Products", href: "/products", labelAr: "المنتجات" },
  { label: "Shared Buying Lists", href: "/buying-lists", labelAr: "قوائم الشراء المشتركة", group: "Buying", groupAr: "الشراء" },
  { label: "Purchase List", href: "/restock-priority/purchase-list", labelAr: "قائمة الشراء", group: "Buying", groupAr: "الشراء" },
  { label: "Physical Stock Count", href: "/inventory/stocktake", labelAr: "الجرد الفعلي", group: "Stock checks", groupAr: "الجرد ومراجعة المخزون" },
  { label: "Monthly Stock Review", href: "/inventory/stock-check", labelAr: "مراجعة مخزون الشهر", group: "Stock checks", groupAr: "الجرد ومراجعة المخزون" },
  { label: "Machine Stock", href: "/inventory/machine-storage", labelAr: "مخزون الماكينات", group: "Stock checks", groupAr: "الجرد ومراجعة المخزون" },
  { label: "Movements", href: "/inventory/movements", labelAr: "حركة المخزون", group: "Stock checks", groupAr: "الجرد ومراجعة المخزون" },
  { label: "Manual Adjustment", href: "/inventory/movements/new", labelAr: "تعديل يدوي", group: "Stock checks", groupAr: "الجرد ومراجعة المخزون" },
  { label: "Product Planning", href: "/product-planning", labelAr: "تخطيط المنتجات", group: "Setup & planning", groupAr: "التهيئة والتخطيط" },
  { label: "Suppliers", href: "/suppliers", labelAr: "الموردون", group: "Setup & planning", groupAr: "التهيئة والتخطيط" },
  { label: "Storage Locations", href: "/storage-locations", labelAr: "مواقع التخزين", group: "Setup & planning", groupAr: "التهيئة والتخطيط" },
];
const machinesTabs: ModuleTab[] = [
  { label: "Machines", href: "/machines", labelAr: "الماكينات", exact: true },
  { label: "Locations", href: "/locations", labelAr: "المواقع" },
  { label: "Planograms", href: "/machine-slots", labelAr: "توزيع المنتجات" },
  { label: "Status", href: "/machines/status", labelAr: "الحالة" },
  { label: "Maintenance", href: "/machines/maintenance", labelAr: "الصيانة" },
];
const crmTabs: ModuleTab[] = [
  { label: "New customer issue", href: "/issues/new", labelAr: "تسجيل بلاغ", exact: true },
  { label: "My Work", href: "/my-work", labelAr: "عملي اليوم", exact: true },
  { label: "Leads & Visits", href: "/locations-pipeline", labelAr: "الجهات والزيارات" },
  { label: "Customer Issues", href: "/issues", labelAr: "مشاكل العملاء" },
  { label: "Existing Locations", href: "/relationships", labelAr: "المواقع الحالية", exact: true, group: "Locations & contacts", groupAr: "المواقع وجهات الاتصال" },
  { label: "Contacts", href: "/contacts", labelAr: "جهات الاتصال", group: "Locations & contacts", groupAr: "المواقع وجهات الاتصال" },
  { label: "Location Payments", href: "/relationships/obligations", labelAr: "دفعات المواقع", group: "Locations & contacts", groupAr: "المواقع وجهات الاتصال" },
  { label: "Follow-ups", href: "/follow-ups", labelAr: "المتابعات", group: "Work & follow-up", groupAr: "العمل والمتابعة" },
  { label: "Management notes", href: "/my-work/notes", labelAr: "ملاحظات الإدارة", exact: true, group: "Work & follow-up", groupAr: "العمل والمتابعة" },
  { label: "Team Work", href: "/my-work/team", labelAr: "عمل الفريق", group: "Work & follow-up", groupAr: "العمل والمتابعة" },
  { label: "Search", href: "/my-work/search", labelAr: "البحث", group: "Tools", groupAr: "أدوات" },
];
const financeTabs: ModuleTab[] = [
  { label: "Overview", href: "/finance", labelAr: "نظرة عامة", exact: true },
  { label: "Transactions", href: "/finance/transactions", labelAr: "المعاملات" },
  { label: "Expenses", href: "/finance/expenses", labelAr: "المصروفات" },
  { label: "Rent", href: "/finance/rent", labelAr: "الإيجارات" },
  { label: "Operations", href: "/finance/operations", labelAr: "العمليات", group: "Operations & planning", groupAr: "العمليات والتخطيط" },
  { label: "Growth Decisions", href: "/finance/growth-decisions", labelAr: "قرارات النمو", group: "Operations & planning", groupAr: "العمليات والتخطيط" },
  { label: "Machine Investments", href: "/finance/machine-investments", labelAr: "استثمارات الماكينات", group: "Operations & planning", groupAr: "العمليات والتخطيط" },
  { label: "Investors", href: "/finance/investors", labelAr: "المستثمرون", group: "People & obligations", groupAr: "الأفراد والالتزامات" },
  { label: "Payroll", href: "/payroll", labelAr: "المرتبات", group: "People & obligations", groupAr: "الأفراد والالتزامات" },
  { label: "Buy USD", href: "/finance/exchange", labelAr: "شراء الدولار", group: "People & obligations", groupAr: "الأفراد والالتزامات" },
  { label: "Reports", href: "/finance/reports", labelAr: "التقارير", group: "Reports & tools", groupAr: "التقارير والأدوات" },
  { label: "Import Review", href: "/finance/import/review", labelAr: "مراجعة الاستيراد", match: ["/finance/import"], group: "Reports & tools", groupAr: "التقارير والأدوات" },
  { label: "Cleanup", href: "/finance/cleanup", labelAr: "التنظيف", group: "Reports & tools", groupAr: "التقارير والأدوات" },
  { label: "Health", href: "/admin/finance-health", labelAr: "سلامة النظام", group: "Reports & tools", groupAr: "التقارير والأدوات" },
];
const adminTabs: ModuleTab[] = [
  { label: "Overview", href: "/admin", labelAr: "نظرة عامة", exact: true },
  { label: "Team", href: "/team", labelAr: "الفريق" },
  { label: "Settings", href: "/settings", labelAr: "الإعدادات" },
  { label: "VMS Import", href: "/vms-import", labelAr: "استيراد VMS" },
  { label: "Stop Override", href: "/admin/stop-override", labelAr: "تجاوز نقطة التوقف" },
  { label: "Activity Log", href: "/activity", labelAr: "سجل النشاط" },
  { label: "Monthly Profit Activation", href: "/vms-import/monthly-profit-repair", labelAr: "تفعيل الربح الشهري" },
  { label: "VMS Data Sources", href: "/vms-import/sources", labelAr: "مصادر بيانات VMS" },
  { label: "XY VMS API", href: "/admin/vms-api", labelAr: "واجهة XY VMS" },
  { label: "Product Mapping", href: "/vms-mappings", labelAr: "مطابقة المنتجات" },
  { label: "Data Health", href: "/operations-health", labelAr: "سلامة البيانات" },
  { label: "Testing Lab", href: "/admin/testing-lab", labelAr: "مختبر الاختبارات" },
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
const companyTabs: ModuleTab[] = [
  { label: "Start Here", labelAr: "ابدأ هنا", href: "/company", exact: true, match: ["/company/start"] },
  { label: "How We Work", labelAr: "كيف نعمل", href: "/company/guides" },
  { label: "Documents & Brand", labelAr: "الوثائق والهوية", href: "/company/documents" },
  { label: "Responsibilities", labelAr: "المسؤوليات", href: "/company/people" },
  { label: "Updates", labelAr: "التحديثات", href: "/company/updates" },
  { label: "Manage", labelAr: "إدارة المحتوى", href: "/company/manage" },
];
const groups: Record<AppModuleKey, ModuleTabGroup> = {
  company: { name: "Company", nameAr: "الشركة", tabs: companyTabs },
  operations: { name: "Operations", nameAr: "العمليات", tabs: operationsTabs },
  cash: { name: "Cash", nameAr: "النقدية", tabs: cashTabs },
  stock: { name: "Stock & Purchasing", nameAr: "المخزون والمشتريات", tabs: stockTabs },
  machines: { name: "Machines", nameAr: "الماكينات", tabs: machinesTabs },
  crm: { name: "Customer Relations", nameAr: "علاقات العملاء", tabs: crmTabs },
  finance: { name: "Finance", nameAr: "المالية", tabs: financeTabs },
  reports: { name: "Reports", nameAr: "التقارير", tabs: reportsTabs },
  admin: { name: "Admin", nameAr: "الإدارة", tabs: adminTabs },
};
export function pathnameFromHref(href: string) { return href.split("?")[0]?.split("#")[0] || href; }
export function getModuleTabGroupForPath(pathname: string): ModuleTabGroup | null { const key = getAppModuleKey(pathname); return key ? groups[key] : null; }
