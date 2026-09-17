import Link from "next/link";
import { CreatePurchaseListButton } from "@/components/CreatePurchaseListButton";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileField, MobileRecordCard, PageHeader } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";
import { loadPurchaseListData } from "@/lib/purchase-list-data";
import type { PurchaseListPeriod } from "@/lib/purchase-list";
import type { BoxPurchaseListItem } from "@/lib/purchase-boxes";
import type { RestockShoppingListItem } from "@/lib/restock-shopping-list";

export const dynamic = "force-dynamic";
const coverageChoices = [7, 14, 30] as const;
const integer = (value: number) => Math.max(0,Math.round(value)).toLocaleString("en-US");
const oneDecimal = (value: number) => value.toLocaleString("en-US",{maximumFractionDigits:1});
function formatPeriod(period: PurchaseListPeriod | null) { return period ? `${period.start} — ${period.end}` : "—"; }
function toDraftItem(item: BoxPurchaseListItem): RestockShoppingListItem {
  return {productId:item.productId,name:item.name,suggestedQty:item.purchaseUnits!,purchaseUnit:"box",unitsPerBox:item.caseQuantity!,boxesQty:item.suggestedBoxesQty!,
    priorityScore:Math.round(item.demandDailyRate*100),status:"recent-demand",lastPurchaseCost:item.lastPurchaseCost};
}
function BuyQuantity({item,ar}: {item:BoxPurchaseListItem;ar:boolean}) {
  if (item.boxSizeMissing || item.suggestedBoxesQty === null) return <Link href={`/products/${item.productId}/edit`} className="font-semibold text-amber-800 underline">{ar ? "حدد حجم الصندوق" : "Set box size"}</Link>;
  return <div><strong className="text-lg text-orange-700">{integer(item.suggestedBoxesQty)} {ar ? "صندوق" : "boxes"}</strong><div className="text-xs text-slate-600">{integer(item.caseQuantity!)} {ar ? "وحدة/صندوق" : "units/box"} · {integer(item.purchaseUnits!)} {ar ? "وحدة إجمالاً" : "total units"}</div></div>;
}
function DemandBadge({item,ar,available}: {item:BoxPurchaseListItem;ar:boolean;available:boolean}) {
  if (!available) return null;
  const faster = item.currentDailyRate > item.previousDailyRate * 1.05;
  const slower = item.previousDailyRate > 0 && item.currentDailyRate < item.previousDailyRate * 0.8;
  return <span className="text-xs text-slate-500">{faster ? (ar ? "أسرع هذا الشهر" : "Faster this month") : slower ? (ar ? "أبطأ هذا الشهر" : "Slower this month") : (ar ? "طلب مستقر" : "Steady demand")}</span>;
}
function PurchaseCard({item,ar,previousAvailable,currentAvailable}: {item:BoxPurchaseListItem;ar:boolean;previousAvailable:boolean;currentAvailable:boolean}) {
  const tr = (en:string,arabic:string) => ar ? arabic : en;
  return <MobileRecordCard>
    <div className="font-semibold text-slate-950">{item.name}</div><DemandBadge item={item} ar={ar} available={previousAvailable && currentAvailable}/>
    <div className="mt-4 grid grid-cols-2 gap-3">
      <MobileField label={tr("Last month","الشهر الماضي")}>{previousAvailable ? integer(item.previousMonthUnits) : "—"}</MobileField>
      <MobileField label={tr("This month","هذا الشهر")}><div>{currentAvailable ? integer(item.currentMonthUnits) : "—"}</div>{currentAvailable && item.currentMonthProjectedUnits > 0 ? <small>{tr("Projected","متوقع")}: {integer(item.currentMonthProjectedUnits)}</small> : null}</MobileField>
      <MobileField label={tr("Storage (units)","المخزون (وحدات)")}>{integer(item.storageQty)}</MobileField>
      <MobileField label={tr("Sales/day","المبيعات/يوم")}>{oneDecimal(item.demandDailyRate)}</MobileField>
      <div className="col-span-2 rounded-lg bg-orange-50 p-3"><BuyQuantity item={item} ar={ar}/></div>
    </div>
  </MobileRecordCard>;
}

export default async function PurchaseListPage({searchParams}: {searchParams:Promise<{days?:string|string[]}>}) {
  await requireCurrentProfileForPath("/restock-priority/purchase-list");
  const params = await searchParams;
  const requested = Number(Array.isArray(params.days) ? params.days[0] : params.days ?? 7);
  const days = coverageChoices.includes(requested as 7|14|30) ? requested : 7;
  const db = await getAuthenticatedSupabaseServerClient();
  const {locale,direction} = await getServerI18n(), ar = locale === "ar";
  const tr = (en:string,arabic:string) => ar ? arabic : en;
  if (!db) return <ErrorState title={tr("Purchase list unavailable","قائمة الشراء غير متاحة")} body={tr("Could not connect to the database.","تعذر الاتصال بقاعدة البيانات.")}/>;
  const result = await loadPurchaseListData(db,days);
  const sourceFailed = Boolean(result.errors.sales || result.errors.salesBatches || result.errors.products);
  if (sourceFailed) return <div dir={direction}><ErrorState title={tr("Purchase list unavailable","قائمة الشراء غير متاحة")} body={tr("Could not verify sales or products. No zero sales or covered stock has been assumed. Reload to retry.","تعذر التحقق من المبيعات أو المنتجات. لم يتم افتراض مبيعات صفرية أو مخزون كافٍ. أعد التحميل.")}/><Link href="/restock-priority/purchase-list" className="btn-secondary">{tr("Retry","إعادة المحاولة")}</Link></div>;
  const salesUnavailable = !result.previousPeriod && !result.currentPeriod;
  const buyItems = result.items.filter(item => item.suggestedBuyQty > 0);
  const readyItems = buyItems.filter(item => !item.boxSizeMissing && Number(item.suggestedBoxesQty) > 0 && Number(item.purchaseUnits) > 0);
  const coveredItems = result.items.filter(item => item.suggestedBuyQty === 0);
  const missingBoxes = buyItems.length - readyItems.length;
  const draftItems = readyItems.map(toDraftItem);
  const totalBoxes = readyItems.reduce((sum,item) => sum + Number(item.suggestedBoxesQty),0);
  const totalUnits = readyItems.reduce((sum,item) => sum + Number(item.purchaseUnits),0);
  const knownCosts = readyItems.filter(item => item.estimatedBuyCost !== null);
  const estimatedCost = knownCosts.reduce((sum,item) => sum + Number(item.estimatedBuyCost),0);
  const action = result.storageLoaded && !salesUnavailable && draftItems.length ? <CreatePurchaseListButton items={draftItems} destination="review"/> : undefined;
  return <div className="space-y-5" dir={direction}>
    <PageHeader title={tr("Purchase List","قائمة الشراء")} subtitle={tr("Recent sales and current storage, with whole boxes to buy.","المبيعات الحديثة والمخزون الحالي مع كمية الشراء بصناديق كاملة.")} action={action}/>
    <section className="surface-card space-y-3">
      <p className="text-sm text-slate-600">{tr("Only products sold last month or this month appear here. Current storage is subtracted first, then the shortage is rounded UP to whole boxes. No individual items or partial boxes are recommended.","تظهر فقط المنتجات المباعة الشهر الماضي أو الحالي. يُخصم المخزون أولاً ثم يُقرب النقص لأعلى إلى صناديق كاملة، دون شراء وحدات مفردة أو أجزاء من صندوق.")}</p>
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{tr("Stock coverage:","تغطية المخزون:")}</span>{coverageChoices.map(value => <Link key={value} href={`/restock-priority/purchase-list?days=${value}`} className={value===days ? "btn-primary" : "btn-secondary"}>{value} {tr("days","أيام")}</Link>)}</div>
      <div className="grid gap-2 text-sm sm:grid-cols-2"><p>{tr("Last month:","الشهر الماضي:")} {formatPeriod(result.previousPeriod)}</p><p>{tr("This month:","هذا الشهر:")} {formatPeriod(result.currentPeriod)}</p></div>
      <p className="text-xs text-slate-500">{tr("Daily demand uses the higher of the two reports’ daily rates. Sales and storage columns show units; buying quantities show boxes. Pending orders and machine stock are not deducted.","يُستخدم الأعلى من معدلي المبيعات اليوميين للتقريرين. المبيعات والمخزون بالوحدات والشراء بالصناديق. لا تُخصم الطلبات المنتظرة أو مخزون الماكينات.")}</p>
      <Link href="/restock-priority/shopping-list" className="text-sm font-medium underline">{tr("Open saved Buying List","فتح قائمة الشراء المحفوظة")}</Link>
    </section>
    {!result.currentPeriod && result.previousPeriod ? <p className="rounded-lg bg-amber-50 p-3 text-sm">{tr("Current-month sales are unavailable; recommendations use last month only.","مبيعات الشهر الحالي غير متاحة؛ تستخدم الاقتراحات الشهر الماضي فقط.")}</p> : null}
    {!result.previousPeriod && result.currentPeriod ? <p className="rounded-lg bg-amber-50 p-3 text-sm">{tr("Last month is unavailable; using this month’s report only.","الشهر الماضي غير متاح؛ نستخدم تقرير هذا الشهر فقط.")}</p> : null}
    {!result.storageLoaded ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{tr("Current storage could not be verified. Buying quantities and draft actions are hidden; reload before purchasing.","تعذر التحقق من المخزون الحالي. تم إخفاء كميات الشراء والمسودة؛ أعد التحميل قبل الشراء.")}</p> : null}
    {salesUnavailable ? <ErrorState title={tr("Recent sales unavailable","المبيعات الحديثة غير متاحة")} body={tr("Activate a report for last month or this month.","فعّل تقريراً للشهر الماضي أو الحالي.")}/> : null}
    {result.unmappedSalesUnits > 0 ? <p className="rounded-lg bg-amber-50 p-3 text-sm">{integer(result.unmappedSalesUnits)} {tr("sold units cannot be matched to Storage until their products are mapped.","وحدة مباعة لا يمكن مطابقتها بالمخزون حتى يتم ربط منتجاتها.")}</p> : null}
    {!salesUnavailable && !result.items.length ? <EmptyState title={tr("No mapped recent sellers","لا توجد منتجات حديثة مربوطة")} body={tr("Check product mappings and active products. This is not proof of adequate storage.","راجع ربط المنتجات والمنتجات النشطة. هذا لا يعني أن المخزون كافٍ.")}/> : null}
    {result.storageLoaded && !salesUnavailable && result.items.length > 0 ? <>
      <div className="grid gap-3 sm:grid-cols-3"><div className="surface-card"><div className="text-sm">{tr("Boxes to buy","صناديق للشراء")}</div><strong className="text-3xl">{integer(totalBoxes)}</strong></div><div className="surface-card"><div className="text-sm">{tr("Units in those boxes","الوحدات داخل الصناديق")}</div><strong className="text-3xl">{integer(totalUnits)}</strong></div><div className="surface-card"><div className="text-sm">{tr("Estimated cost","التكلفة التقديرية")}</div><strong className="text-xl">{knownCosts.length ? `${estimatedCost.toFixed(2)} LYD` : "—"}</strong>{knownCosts.length < readyItems.length ? <p className="text-xs">{tr("Some costs are missing; total is incomplete.","بعض التكاليف مفقودة؛ الإجمالي غير مكتمل.")}</p> : null}</div></div>
      {missingBoxes > 0 ? <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{missingBoxes} {tr("products need a box size. They remain visible below but are excluded from box totals and the draft. A default size of 1 is not treated as a wholesale box.","منتجات تحتاج تحديد حجم الصندوق. تظل ظاهرة أدناه لكنها لا تدخل في إجمالي الصناديق أو المسودة. القيمة الافتراضية 1 لا تُعد صندوقاً بالجملة.")}</p> : null}
      {buyItems.length > 0 ? <section className="surface-card space-y-4"><h2 className="text-xl font-semibold">{tr("Buy these first","اشترِ هذه أولاً")}</h2><p className="text-sm text-slate-500">{tr("Highest recent daily sales first. Every buying quantity is whole boxes.","الأعلى مبيعاً يومياً أولاً. جميع كميات الشراء بصناديق كاملة.")}</p>
        <MobileCardList>{buyItems.map(item => <PurchaseCard key={item.productId} item={item} ar={ar} previousAvailable={Boolean(result.previousPeriod)} currentAvailable={Boolean(result.currentPeriod)}/>)}</MobileCardList>
        <DataTable className="hidden md:block" headers={[tr("Product","المنتج"),tr("Last month (units)","الشهر الماضي (وحدات)"),tr("This month (units)","هذا الشهر (وحدات)"),tr("Storage (units)","المخزون (وحدات)"),tr("Sales/day","مبيعات/يوم"),tr("Buy boxes","صناديق للشراء")]}>{buyItems.map(item => <tr key={item.productId}><td><strong>{item.name}</strong><div><DemandBadge item={item} ar={ar} available={Boolean(result.currentPeriod && result.previousPeriod)}/></div></td><td>{result.previousPeriod ? integer(item.previousMonthUnits) : "—"}</td><td>{result.currentPeriod ? integer(item.currentMonthUnits) : "—"}</td><td>{integer(item.storageQty)}</td><td>{oneDecimal(item.demandDailyRate)}</td><td><BuyQuantity item={item} ar={ar}/></td></tr>)}</DataTable>
        {action}
      </section> : <EmptyState title={tr("Nothing to buy for this coverage window","لا توجد مشتريات مطلوبة لهذه الفترة")} body={tr("Current storage covers the selected period for mapped recent sellers.","المخزون الحالي يغطي الفترة المحددة للمنتجات الحديثة المربوطة.")}/>}
      {coveredItems.length > 0 ? <details className="surface-card"><summary className="cursor-pointer font-semibold">{tr("Already covered by Storage","المخزون الحالي كافٍ")} ({coveredItems.length})</summary><div className="mt-3 space-y-2">{coveredItems.map(item => <div key={item.productId} className="flex justify-between gap-4 text-sm"><span>{item.name}</span><span>{integer(item.storageQty)} {tr("units in storage — buy 0 boxes","وحدة في المخزون — شراء 0 صندوق")}</span></div>)}</div></details> : null}
    </> : null}
  </div>;
}
