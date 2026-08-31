import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";

type Locale = "ar" | "en";
const tr = (locale: Locale, en: string, ar: string) => locale === "ar" ? ar : en;

export default async function ReportsPage() {
  await requireCurrentProfileForPath("/reports");
  const { locale } = await getServerI18n();
  const groups = [
    {
      title: tr(locale, "Operations", "العمليات"),
      description: tr(locale, "Routes, operators, refills, and field exceptions.", "الجولات والمشغلون والتعبئة والاستثناءات الميدانية."),
      reports: [
        { title: tr(locale, "Monthly Operations", "التقرير التشغيلي الشهري"), href: "/reports/route-performance", description: tr(locale, "Routes, machines filled, units, operator performance, daily activity, and exceptions.", "الجولات والأجهزة المعبأة والوحدات وأداء المشغلين والنشاط اليومي والاستثناءات."), featured: true },
        { title: tr(locale, "Route Product Activity", "نشاط منتجات الجولات"), href: "/reports/route-product-activity", description: tr(locale, "Manual sales, damaged products, machine returns, missing products, and safety proof.", "المبيعات اليدوية والمنتجات التالفة والمرتجعات والنواقص وإثبات السلامة.") },
        { title: tr(locale, "Inventory Adjustments", "تعديلات المخزون"), href: "/reports/inventory-adjustments", description: tr(locale, "Damaged stock, returned machine items, and route-scoped adjustment history.", "المخزون التالف ومرتجعات الأجهزة وسجل تعديلات الجولات.") },
      ],
    },
    {
      title: tr(locale, "Sales and cash", "المبيعات والنقدية"),
      description: tr(locale, "Sales performance and cash accountability.", "أداء المبيعات ومطابقة النقدية."),
      reports: [
        { title: tr(locale, "Sales Dashboard", "لوحة المبيعات"), href: "/sales", description: tr(locale, "VMS sales by day, machine, location, product, and payment type.", "مبيعات نظام الأجهزة حسب اليوم والجهاز والموقع والمنتج وطريقة الدفع.") },
        { title: tr(locale, "Cash Reconciliation", "مطابقة النقدية"), href: "/reports/cash-reconciliation", description: tr(locale, "Expected cash, actual counted cash, variance, and pending collections.", "النقد المتوقع والمبلغ الفعلي والفرق والتحصيلات المعلقة.") },
      ],
    },
    {
      title: tr(locale, "Performance and planning", "الأداء والتخطيط"),
      description: tr(locale, "Machine, product, and inventory decisions.", "قرارات الأجهزة والمنتجات والمخزون."),
      reports: [
        { title: tr(locale, "Machine Dashboard", "لوحة الأجهزة"), href: "/machines-dashboard", description: tr(locale, "Machine sales, refill activity, cash variance, issues, and rent-aware profit.", "مبيعات الأجهزة والتعبئة وفروقات النقدية والمشاكل والربح بعد الإيجار.") },
        { title: tr(locale, "Product Dashboard", "لوحة المنتجات"), href: "/products-dashboard", description: tr(locale, "Velocity, revenue, margins, stockouts, and storage coverage.", "سرعة البيع والإيراد والهامش ونفاد المخزون وتغطية المخزن.") },
        { title: tr(locale, "Inventory Dashboard", "لوحة المخزون"), href: "/inventory-dashboard", description: tr(locale, "Ledger stock, route reservations, low storage, and purchase suggestions.", "رصيد السجل وحجوزات الجولات ونقص المخزن واقتراحات الشراء.") },
      ],
    },
    {
      title: tr(locale, "Data quality", "جودة البيانات"),
      description: tr(locale, "Know whether the source data is complete before trusting a KPI.", "تحقق من اكتمال بيانات المصدر قبل الاعتماد على المؤشرات."),
      reports: [
        { title: tr(locale, "Sales Data Coverage", "تغطية بيانات المبيعات"), href: "/reports/sales-coverage", description: tr(locale, "Month and day coverage, imported file status, and source health.", "تغطية الأشهر والأيام وحالة الملفات المستوردة وصحة المصدر.") },
      ],
    },
  ];

  return <div className="space-y-8" dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader title={tr(locale, "Reports", "التقارير")} subtitle={tr(locale, "Organized operational, financial, performance, and data-quality reporting for Snacky.", "تقارير سناكي التشغيلية والمالية وتقارير الأداء وجودة البيانات في مكان واحد.")} />
    {groups.map((group) => <section key={group.title}>
      <div className="mb-3"><h2 className="text-lg font-semibold text-slate-950">{group.title}</h2><p className="text-sm text-slate-500">{group.description}</p></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {group.reports.map((item) => <Link key={item.href} href={item.href} className={`block rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${item.featured ? "border-orange-300 ring-1 ring-orange-100" : "border-slate-200 hover:border-slate-300"}`}>
          {item.featured ? <div className="mb-3 inline-flex rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-800">{tr(locale, "Start here", "ابدأ من هنا")}</div> : null}
          <div className="text-base font-semibold text-slate-950">{item.title}</div>
          <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
        </Link>)}
      </div>
    </section>)}
  </div>;
}
