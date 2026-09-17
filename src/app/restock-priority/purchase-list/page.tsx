import Link from "next/link";
import { CreatePurchaseListButton } from "@/components/CreatePurchaseListButton";
import {
  DataTable,
  EmptyState,
  ErrorState,
  MobileCardList,
  MobileField,
  MobileRecordCard,
  PageHeader,
} from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";
import { loadPurchaseListData } from "@/lib/purchase-list-data";
import type { PurchaseListItem, PurchaseListPeriod } from "@/lib/purchase-list";
import type { RestockShoppingListItem } from "@/lib/restock-shopping-list";

export const dynamic = "force-dynamic";

const coverageChoices = [7, 14, 30] as const;

function integer(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function oneDecimal(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatPeriod(period: PurchaseListPeriod | null, locale: string) {
  if (!period) return "—";
  const formatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const start = formatter.format(new Date(`${period.start}T00:00:00Z`));
  const end = formatter.format(new Date(`${period.end}T00:00:00Z`));
  return `${start} – ${end}`;
}

function toDraftItem(item: PurchaseListItem): RestockShoppingListItem {
  return {
    productId: item.productId,
    name: item.name,
    suggestedQty: item.suggestedBuyQty,
    priorityScore: Math.round(item.demandDailyRate * 100),
    status: "recent-demand",
    lastPurchaseCost: item.lastPurchaseCost,
  };
}

function DemandBadge({ item, ar }: { item: PurchaseListItem; ar: boolean }) {
  const accelerating = item.currentDailyRate > item.previousDailyRate * 1.05;
  const slowing = item.previousDailyRate > 0 && item.currentDailyRate < item.previousDailyRate * 0.8;
  if (accelerating) {
    return <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800">{ar ? "أسرع هذا الشهر" : "Faster this month"}</span>;
  }
  if (slowing) {
    return <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">{ar ? "أبطأ هذا الشهر" : "Slower this month"}</span>;
  }
  return <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">{ar ? "طلب مستقر" : "Steady demand"}</span>;
}

function PurchaseCard({ item, rank, storageReliable, ar }: { item: PurchaseListItem; rank: number; storageReliable: boolean; ar: boolean }) {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold text-slate-400">#{rank}</div>
          <div className="text-base font-semibold text-slate-950">{item.name}</div>
          <div className="mt-1 text-xs text-slate-500">{item.sku ?? "—"}</div>
        </div>
        <DemandBadge item={item} ar={ar} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MobileField label={tr("Last month", "الشهر الماضي")}>{integer(item.previousMonthUnits)}</MobileField>
        <MobileField label={tr("This month", "هذا الشهر")}>
          <div>{integer(item.currentMonthUnits)}</div>
          {item.currentMonthProjectedUnits > 0 ? <div className="text-[11px] text-slate-500">{tr("Projected", "متوقع")}: {integer(item.currentMonthProjectedUnits)}</div> : null}
        </MobileField>
        <MobileField label={tr("Storage now", "المخزون الآن")}>{storageReliable ? integer(item.storageQty) : "—"}</MobileField>
        <MobileField label={tr("Sales / day", "المبيعات / يوم")}>{oneDecimal(item.demandDailyRate)}</MobileField>
        <MobileField label={tr("Days in storage", "أيام تغطية المخزون")}>{storageReliable && item.stockCoverageDays !== null ? oneDecimal(item.stockCoverageDays) : "—"}</MobileField>
        <MobileField label={tr("Buy", "اشترِ")}><strong className="text-lg text-orange-700">{storageReliable ? integer(item.suggestedBuyQty) : "—"}</strong></MobileField>
      </div>
    </MobileRecordCard>
  );
}

export default async function PurchaseListPage({ searchParams }: { searchParams: Promise<{ days?: string | string[] }> }) {
  await requireCurrentProfileForPath("/restock-priority/purchase-list");
  const params = await searchParams;
  const rawDays = Array.isArray(params.days) ? params.days[0] : params.days;
  const parsedDays = Number(rawDays ?? 7);
  const coverageDays = coverageChoices.includes(parsedDays as (typeof coverageChoices)[number]) ? parsedDays : 7;
  const supabase = await getAuthenticatedSupabaseServerClient();
  const { locale, direction } = await getServerI18n();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  if (!supabase) {
    return <ErrorState title={tr("Purchase list unavailable", "قائمة الشراء غير متاحة")} body={tr("Snacky OS could not connect to the database.", "تعذر اتصال سناكي OS بقاعدة البيانات.")} />;
  }

  const result = await loadPurchaseListData(supabase, coverageDays);
  const buyItems = result.storageLoaded ? result.items.filter((item) => item.suggestedBuyQty > 0) : [];
  const coveredItems = result.items.filter((item) => item.suggestedBuyQty <= 0);
  const draftItems = buyItems.map(toDraftItem);
  const totalSuggestedUnits = buyItems.reduce((sum, item) => sum + item.suggestedBuyQty, 0);
  const knownCostItems = buyItems.filter((item) => item.estimatedBuyCost !== null);
  const estimatedCost = knownCostItems.reduce((sum, item) => sum + Number(item.estimatedBuyCost ?? 0), 0);
  const missingCostCount = buyItems.length - knownCostItems.length;
  const salesUnavailable = !result.previousPeriod && !result.currentPeriod;

  return (
    <div className="space-y-6" dir={direction}>
      <PageHeader
        title={tr("Purchase List", "قائمة الشراء")}
        subtitle={tr(
          "What Snacky should buy now, based on last month, this month-to-date, and current storage.",
          "ما يجب على سناكي شراؤه الآن بناءً على مبيعات الشهر الماضي وهذا الشهر والمخزون الحالي.",
        )}
        breadcrumbs={[
          { label: tr("Stock & Purchasing", "المخزون والمشتريات"), href: "/inventory" },
          { label: tr("Purchase List", "قائمة الشراء") },
        ]}
        action={result.storageLoaded && !salesUnavailable ? <CreatePurchaseListButton items={draftItems} className="w-full justify-center sm:w-auto" /> : undefined}
      />

      <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        <div className="font-semibold">{tr("Simple rule", "القاعدة البسيطة")}</div>
        <p className="mt-1">
          {tr(
            "Only products sold last month or this month appear here. Products that sold only several months ago are excluded. Current storage is subtracted before Snacky suggests what to buy.",
            "تظهر هنا فقط المنتجات التي بيعت الشهر الماضي أو هذا الشهر. المنتجات التي كانت تُباع قبل عدة أشهر فقط لا تظهر. يُخصم المخزون الحالي قبل اقتراح كمية الشراء.",
          )}
        </p>
      </section>

      <section className="surface-card">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-950">{tr("How many days should this purchase cover?", "كم يوم تريد أن يغطي هذا الشراء؟")}</div>
            <p className="mt-1 text-xs text-slate-500">{tr("7 days is the default. Choose 14 or 30 when you want to buy further ahead.", "الافتراضي 7 أيام. اختر 14 أو 30 إذا أردت شراء مخزون لفترة أطول.")}</p>
          </div>
          <div className="flex gap-2">
            {coverageChoices.map((days) => (
              <Link key={days} href={`/restock-priority/purchase-list?days=${days}`} className={days === coverageDays ? "btn-primary" : "btn-secondary"}>
                {days} {tr("days", "أيام")}
              </Link>
            ))}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs font-semibold text-slate-500">{tr("Previous sales source", "مصدر مبيعات الشهر الماضي")}</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{formatPeriod(result.previousPeriod, locale)}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs font-semibold text-slate-500">{tr("Current sales source", "مصدر مبيعات الشهر الحالي")}</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{formatPeriod(result.currentPeriod, locale)}</div>
          </div>
        </div>
      </section>

      {!result.currentPeriod && result.previousPeriod ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {tr("Current-month sales are not available yet, so recommendations use last month only.", "مبيعات الشهر الحالي غير متاحة بعد، لذلك تعتمد الاقتراحات على الشهر الماضي فقط.")}
        </div>
      ) : null}
      {!result.previousPeriod && result.currentPeriod ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {tr("Last-month sales are not available, so recommendations use the current month-to-date only.", "مبيعات الشهر الماضي غير متاحة، لذلك تعتمد الاقتراحات على مبيعات الشهر الحالي حتى الآن فقط.")}
        </div>
      ) : null}
      {!result.storageLoaded ? (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-900">
          {tr("Current storage could not be verified. Purchase quantities are hidden so Snacky does not tell you to overbuy. Reload after Storage is available.", "تعذر التحقق من المخزون الحالي. تم إخفاء كميات الشراء حتى لا يقترح سناكي شراء كمية زائدة. أعد التحميل بعد عودة بيانات المخزون.")}
        </div>
      ) : null}
      {salesUnavailable ? (
        <ErrorState title={tr("Recent sales unavailable", "المبيعات الحديثة غير متاحة")} body={tr("Upload or activate the monthly product sales report for last month or this month before using the purchase list.", "ارفع أو فعّل تقرير مبيعات المنتجات الشهري للشهر الماضي أو الحالي قبل استخدام قائمة الشراء.")} />
      ) : null}
      {result.unmappedSalesUnits > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {tr(
            `${integer(result.unmappedSalesUnits)} recent sold units across ${result.unmappedSalesRows} sales rows are not mapped to a Snacky product, so they cannot be matched safely to Storage yet.`,
            `${integer(result.unmappedSalesUnits)} وحدة مباعة حديثاً ضمن ${result.unmappedSalesRows} سطر مبيعات غير مربوطة بمنتج في سناكي، لذلك لا يمكن مطابقتها بالمخزون بأمان حتى الآن.`,
          )}
        </div>
      ) : null}

      {!salesUnavailable ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">{tr("Products to buy", "منتجات للشراء")}</div>
            <div className="mt-2 text-3xl font-semibold text-orange-900">{result.storageLoaded ? buyItems.length : "—"}</div>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">{tr("Suggested units", "الوحدات المقترحة")}</div>
            <div className="mt-2 text-3xl font-semibold text-amber-900">{result.storageLoaded ? integer(totalSuggestedUnits) : "—"}</div>
          </div>
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">{tr("Recent sellers", "منتجات مباعة حديثاً")}</div>
            <div className="mt-2 text-3xl font-semibold text-sky-900">{result.items.length}</div>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{tr("Already covered", "المخزون كافٍ")}</div>
            <div className="mt-2 text-3xl font-semibold text-emerald-900">{result.storageLoaded ? coveredItems.length : "—"}</div>
          </div>
        </div>
      ) : null}

      {result.storageLoaded && buyItems.length ? (
        <section className="surface-card space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">{tr("Buy these first", "اشترِ هذه أولاً")}</h2>
              <p className="mt-1 text-sm text-slate-600">{tr("Highest current sales rate first. Suggested quantity brings Storage up to your selected coverage target.", "مرتبة من الأعلى مبيعاً. الكمية المقترحة ترفع المخزون لتغطية عدد الأيام الذي اخترته.")}</p>
            </div>
            <CreatePurchaseListButton items={draftItems} className="w-full justify-center sm:w-auto" />
          </div>

          <MobileCardList>
            {buyItems.map((item, index) => <PurchaseCard key={item.productId} item={item} rank={index + 1} storageReliable={result.storageLoaded} ar={ar} />)}
          </MobileCardList>

          <DataTable className="hidden md:block" headers={[
            "#",
            tr("Product", "المنتج"),
            tr("Last month", "الشهر الماضي"),
            tr("This month", "هذا الشهر"),
            tr("Storage", "المخزون"),
            tr("Sales/day", "مبيعات/يوم"),
            tr("Days left", "أيام متبقية"),
            tr("Buy", "اشترِ"),
          ]}>
            {buyItems.map((item, index) => (
              <tr key={item.productId}>
                <td className="text-slate-400">{index + 1}</td>
                <td>
                  <div className="font-semibold text-slate-950">{item.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>{item.sku ?? "—"}</span><DemandBadge item={item} ar={ar} /></div>
                </td>
                <td>{integer(item.previousMonthUnits)}</td>
                <td>
                  <div>{integer(item.currentMonthUnits)}</div>
                  {item.currentMonthProjectedUnits > 0 ? <div className="text-xs text-slate-500">{tr("Projected", "متوقع")}: {integer(item.currentMonthProjectedUnits)}</div> : null}
                </td>
                <td>{integer(item.storageQty)}</td>
                <td className="font-medium">{oneDecimal(item.demandDailyRate)}</td>
                <td>{item.stockCoverageDays === null ? "—" : oneDecimal(item.stockCoverageDays)}</td>
                <td className="text-lg font-bold text-orange-700">{integer(item.suggestedBuyQty)}</td>
              </tr>
            ))}
          </DataTable>

          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
            <strong>{tr("Estimated purchase value", "القيمة التقديرية للشراء")}:</strong>{" "}
            {knownCostItems.length ? `${estimatedCost.toLocaleString("en-US", { maximumFractionDigits: 2 })} LYD` : "—"}
            {missingCostCount > 0 ? <span className="ms-2 text-slate-500">({tr(`cost missing for ${missingCostCount} item(s)`, `التكلفة غير متوفرة لـ ${missingCostCount} منتج`)})</span> : null}
          </div>
        </section>
      ) : null}

      {result.storageLoaded && !salesUnavailable && !buyItems.length ? (
        <EmptyState title={tr("Nothing to buy for this coverage window", "لا توجد مشتريات مطلوبة لهذه الفترة")} body={tr("Current Storage already covers the recent sales rate for the selected number of days.", "المخزون الحالي يغطي معدل المبيعات الحديث لعدد الأيام المحدد.")} />
      ) : null}

      {result.storageLoaded && coveredItems.length ? (
        <details className="surface-card">
          <summary className="cursor-pointer font-semibold text-slate-950">{tr(`Already covered by Storage (${coveredItems.length})`, `المخزون الحالي كافٍ (${coveredItems.length})`)}</summary>
          <p className="mt-2 text-sm text-slate-600">{tr("These products sold recently but do not need to be purchased for the selected coverage window.", "هذه المنتجات بيعت مؤخراً ولكن لا تحتاج شراءً ضمن فترة التغطية المحددة.")}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="border-b text-start text-xs text-slate-500"><th className="p-2 text-start">{tr("Product", "المنتج")}</th><th className="p-2 text-start">{tr("Sales/day", "مبيعات/يوم")}</th><th className="p-2 text-start">{tr("Storage", "المخزون")}</th><th className="p-2 text-start">{tr("Days covered", "أيام التغطية")}</th></tr></thead>
              <tbody>{coveredItems.map((item) => <tr key={item.productId} className="border-b border-slate-100"><td className="p-2 font-medium">{item.name}</td><td className="p-2">{oneDecimal(item.demandDailyRate)}</td><td className="p-2">{integer(item.storageQty)}</td><td className="p-2">{item.stockCoverageDays === null ? "—" : oneDecimal(item.stockCoverageDays)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
