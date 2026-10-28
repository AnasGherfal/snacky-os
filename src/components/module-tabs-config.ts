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
  { label: "What to Buy", href: "/restock-priority/purchase-list", labelAr: "شن نشتري؟", exact: true },
  { label: "Purchases", href: "/purchases", labelAr: "المشتريات" },
  { label: "Products", href: "/products", labelAr: "المنتجات" },
  { label: "Buying Lists", href: "/buying-lists", labelAr: "قوائم الشراء", group: "Daily work", groupAr: "العمل اليومي" },
  { label: "Physical Count", href: "/inventory/stocktake", labelAr: "الجرد الفعلي", group: "Stock controls", groupAr: "مراجعة المخزون" },
  { label: "Movement History", href: "/inventory/movements", labelAr: "سجل حركة المخزون", group: "Stock controls", groupAr: "مراجعة المخزون" },
  { label: "Stock Investigation", href: "/inventory/reconciliation", labelAr: "التحقيق في الفاقد", group: "Stock controls", groupAr: "مراجعة المخزون" },
  { label: "Suppliers", href: "/suppliers", labelAr: "الموردون", group: "Setup", groupAr: "الإعداد", advanced: true },
];
const machinesTabs: ModuleTab[] = [
  { label: "Machines", href: "/machines", labelAr: "الماكينات", exact: true },
  { label: "Locations", href: "/locations", labelAr: "المواقع" },
  { label: "Status", href: "/machines/status", labelAr: "الحالة" },
  { label: "Maintenance", href: "/machines/maintenance", labelAr: "الصيانة" },
  { label: "Planograms", href: "/machine-slots", labelAr: "توزيع المنتجات", group: "Machine setup", groupAr: "إعداد الماكينات" },
];
const crmTabs: ModuleTab[] = [
  { label: "My Work", href: "/my-work", labelAr: "عملي اليوم", exact: true },
  { label: "Customer Issues", href: "/issues", labelAr: "بلاغات العملاء" },
  { label: "Leads & Visits", href: "/locations-pipeline", labelAr: "الجهات والزيارات" },
  { label: "Follow-ups", href: "/follow-ups", labelAr: "المتابعات" },
  { label: "Locations", href: "/relationships", labelAr: "المواقع", exact: true, group: "Relationships", groupAr: "العلاقات" },
  { label: "New Issue", href: "/issues/new", labelAr: "بلاغ جديد", exact: true, group: "Actions", groupAr: "الإجراءات" },
  { label: "Contacts", href: "/contacts", labelAr: "جهات الاتصال", group: "Records", groupAr: "السجلات", advanced: true },
  { label: "Location Payments", href: "/relationships/obligations", labelAr: "دفعات المواقع", group: "Records", groupAr: "السجلات", advanced: true },
  { label: "Team Work", href: "/my-work/team", labelAr: "عمل الفريق", group: "Records", groupAr: "السجلات", advanced: true },
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
  { label: "Import Review", href: "/finance/import/review", labelAr: "مراجعة الاستيراد", match: ["/finance/import"], group: "Reports & tools", groupAr: "التقارير والأدوات", advanced: true },
  { label: "Cleanup", href: "/finance/cleanup", labelAr: "التنظيف", group: "Reports & tools", groupAr: "التقارير والأدوات", advanced: true },
  { label: "Health", href: "/admin/finance-health", labelAr: "سلامة النظام", group: "Reports & tools", groupAr: "التقارير والأدوات", advanced: true },
];
const adminTabs: ModuleTab[] = [
  { label: "Overview", href: "/admin", labelAr: "نظرة عامة", exact: true },
  { label: "Team", href: "/team", labelAr: "الفريق" },
  { label: "Settings", href: "/settings", labelAr: "الإعدادات" },
  { label: "XY VMS API", href: "/admin/vms-api", labelAr: "واجهة XY VMS" },
  { label: "Data Health", href: "/operations-health", labelAr: "سلامة البيانات" },
  { label: "VMS Import", href: "/vms-import", labelAr: "استيراد VMS", group: "Data setup", groupAr: "إعداد البيانات" },
  { label: "Stop Override", href: "/admin/stop-override", labelAr: "تجاوز نقطة التوقف", group: "Emergency & audit", groupAr: "الاستثناءات والمراجعة", advanced: true },
  { label: "Activity Log", href: "/activity", labelAr: "سجل النشاط", group: "Emergency & audit", groupAr: "الاستثناءات والمراجعة", advanced: true },
  { label: "Monthly Profit Activation", href: "/vms-import/monthly-profit-repair", labelAr: "تفعيل الربح الشهري", group: "Data repair", groupAr: "إصلاح البيانات", advanced: true },
  { label: "VMS Data Sources", href: "/vms-import/sources", labelAr: "مصادر بيانات VMS", group: "Data repair", groupAr: "إصلاح البيانات", advanced: true },
  { label: "Product Mapping", href: "/vms-mappings", labelAr: "مطابقة المنتجات", group: "Data setup", groupAr: "إعداد البيانات", advanced: true },
  { label: "Testing Lab", href: "/admin/testing-lab", labelAr: "مختبر الاختبارات", group: "Data repair", groupAr: "إصلاح البيانات", advanced: true },
];
const reportsTabs: ModuleTab[] = [
  { label: "Overview", href: "/reports", labelAr: "نظرة عامة", exact: true },
  { label: "Sales", href: "/sales", labelAr: "المبيعات" },
  { label: "Cash Reconciliation", href: "/reports/cash-reconciliation", labelAr: "مطابقة النقدية" },
  { label: "Monthly Operations", href: "/reports/route-performance", labelAr: "الأداء الشهري" },
  { label: "Route Product Activity", href: "/reports/route-product-activity", labelAr: "نشاط منتجات الجولات", group: "Operations detail", groupAr: "تفاصيل العمليات" },
];
const companyTabs: ModuleTab[] = [
  { label: "Start Here", labelAr: "ابدأ هنا", href: "/company", exact: true, match: ["/company/start"] },
  { label: "How We Work", labelAr: "كيف نعمل", href: "/company/guides" },
  { label: "Documents & Brand", labelAr: "الوثائق والهوية", href: "/company/documents" },
  { label: "Responsibilities", labelAr: "المسؤوليات", href: "/company/people" },
  { label: "Updates", labelAr: "التحديثات", href: "/company/updates" },
  { label: "Manage", labelAr: "إدارة المحتوى", href: "/company/manage", group: "Manage", groupAr: "الإدارة", advanced: true },
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


/**
 * Creation and editing are focused workflows. Showing the full module tab
 * strip above a long form crowds the Save/Apply action and encourages
 * accidental navigation. List, overview and audit pages retain tabs.
 * All hidden tab destinations remain accessible via sidebar/More.
 */
export function isFocusedWorkFormPath(pathname: string): boolean {
  return [
    /^\/routes\/new(?:\/|$)/,
    /^\/routes\/[^/]+\/edit(?:\/|$)/,
    /^\/purchases\/new(?:\/|$)/,
    /^\/purchases\/[^/]+\/edit(?:\/|$)/,
    /^\/products\/new(?:\/|$)/,
    /^\/products\/[^/]+\/edit(?:\/|$)/,
    /^\/machines\/new(?:\/|$)/,
    /^\/machines\/[^/]+\/edit(?:\/|$)/,
    /^\/issues\/new(?:\/|$)/,
    /^\/issues\/[^/]+\/edit(?:\/|$)/,
    /^\/finance\/transactions\/new(?:\/|$)/,
    /^\/finance\/transactions\/[^/]+\/edit(?:\/|$)/,
    /^\/cash-collections\/new(?:\/|$)/,
    /^\/cash-collections\/[^/]+\/edit(?:\/|$)/,
    /^\/locations-pipeline\/new(?:\/|$)/,
    /^\/locations-pipeline\/[^/]+\/edit(?:\/|$)/,
    /^\/inventory\/movements\/new(?:\/|$)/,
    /^\/team\/new(?:\/|$)/,
    /^\/team\/[^/]+\/edit(?:\/|$)/,
    /^\/suppliers\/new(?:\/|$)/,
    /^\/storage-locations\/new(?:\/|$)/,
    /^\/storage-locations\/[^/]+\/edit(?:\/|$)/,
    /^\/locations\/new(?:\/|$)/,
    /^\/machine-slots\/new(?:\/|$)/,
    /^\/machine-slots\/[^/]+\/edit(?:\/|$)/,
    /^\/contacts\/new(?:\/|$)/,
    /^\/follow-ups\/new(?:\/|$)/,
    /^\/relationships\/obligations\/new(?:\/|$)/,
  ].some((pattern) => pattern.test(pathname));
}
