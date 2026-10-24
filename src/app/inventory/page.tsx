import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, MobileCardList, MobileRecordCard, PageHeader, PrimaryButton, SearchInput, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { formatProductQuantity } from "@/lib/product-quantity";
import { cleanSearchParams, getPagination, type SearchParamsRecord } from "@/lib/pagination";
import { loadStorageOverview } from "@/lib/storage-overview-data";
import type { StorageOverviewRow } from "@/lib/storage-overview";

export const dynamic = "force-dynamic";

type Filter = "stocked" | "low" | "empty" | "reserved" | "issues" | "all";
const validFilters: readonly Filter[] = ["stocked", "low", "empty", "reserved", "issues", "all"];
function stockPath(filter: Filter, query: string) {
  const params = new URLSearchParams();
  if (filter !== "stocked") params.set("filter", filter);
  if (query.trim()) params.set("q", query.trim());
  return `/inventory${params.size ? `?${params}` : ""}`;
}
const statusLabels: Record<StorageOverviewRow["status"], [string, string]> = {
  negative: ["Negative balance", "رصيد سالب"],
  overbooked: ["Over-reserved", "الحجز أكبر من المخزون"],
  unverified: ["Reservation unknown", "الحجز غير مؤكد"],
  empty: ["Out of stock", "نافد من المخزن"],
  low: ["Low on shelf", "كمية قليلة"],
  stocked: ["In stock", "متوفر"],
};
const statusStyles: Record<StorageOverviewRow["status"], string> = {
  negative: "border-rose-200 bg-rose-50 text-rose-800",
  overbooked: "border-rose-200 bg-rose-50 text-rose-800",
  unverified: "border-amber-200 bg-amber-50 text-amber-900",
  empty: "border-slate-200 bg-slate-100 text-slate-700",
  low: "border-amber-200 bg-amber-50 text-amber-900",
  stocked: "border-emerald-200 bg-emerald-50 text-emerald-800",
};
function matchesFilter(row: StorageOverviewRow, filter: Filter) {
  switch (filter) {
    case "stocked": return row.physical !== 0 || (row.reserved ?? 0) > 0;
    case "low": return row.status === "low" || row.status === "negative" || row.status === "overbooked";
    case "empty": return row.physical === 0;
    case "reserved": return (row.reserved ?? 0) > 0;
    case "issues": return ["negative", "overbooked", "unverified"].includes(row.status);
    default: return true;
  }
}
function packagingHint(row: StorageOverviewRow) {
  if (row.physical <= 0 || row.caseQuantity <= 1) return null;
  return formatProductQuantity(row.physical, {
    caseQuantity: row.caseQuantity, productName: row.name, category: row.category,
  }, { compact: true });
}
function formatUnits(value: number | null, locale: "ar" | "en") {
  return value === null ? "—" : new Intl.NumberFormat(locale === "ar" ? "ar-LY" : "en-US").format(value);
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const params = cleanSearchParams(await searchParams);
  const { locale, direction } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const profile = await getCurrentProfile();
  const context = profile
    ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }
    : null;
  if (!profile || !canAccessPath(context, "/inventory")) redirect("/unauthorized");
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return <ErrorState title={tr("Storage unavailable", "المخزن غير متاح")} body={tr("Your database session could not be loaded.", "تعذر فتح جلسة قاعدة البيانات.")}/>;

  let loaded: Awaited<ReturnType<typeof loadStorageOverview>>;
  try { loaded = await loadStorageOverview(db); }
  catch (error) {
    unstable_rethrow(error);
    console.error("[storage] Cannot verify physical stock ledger", error);
    return <ErrorState
      title={tr("Storage cannot be verified", "تعذر التحقق من المخزون")}
      body={tr("The physical stock ledger could not be loaded completely. Snacky will not display missing quantities as zero. Retry before picking or purchasing.", "تعذر تحميل رصيد المخزون الفعلي بالكامل. لن يعرض سناكي الكميات الناقصة كصفر. أعد المحاولة قبل السحب أو الشراء.")}
      action={<SecondaryButton href="/inventory">{tr("Retry", "إعادة المحاولة")}</SecondaryButton>}
    />;
  }

  const { overview, reservationWarning } = loaded;
  const q = String(params.q ?? "").trim().toLowerCase();
  const filter = validFilters.includes(params.filter as Filter) ? params.filter as Filter : "stocked";
  const { page, pageSize } = getPagination(params);
  const count = (candidate: Filter) => overview.rows.filter(row => matchesFilter(row,candidate)).length;
  const filters: Array<{ key: Filter; en: string; ar: string }> = [
    { key: "stocked", en: "On shelves", ar: "على الرفوف" },
    { key: "low", en: "Low", ar: "كمية قليلة" },
    { key: "reserved", en: "Reserved", ar: "محجوز" },
    { key: "empty", en: "Empty", ar: "نافد" },
    { key: "issues", en: "Review", ar: "للمراجعة" },
    { key: "all", en: "All products", ar: "كل المنتجات" },
  ];
  const filtered = overview.rows.filter(row =>
    matchesFilter(row, filter) && [row.name,row.sku,row.category].some(value => String(value ?? "").toLowerCase().includes(q))
  ).sort((a,b) => {
    const danger = (x: StorageOverviewRow) => ["negative","overbooked","unverified"].includes(x.status) ? 0 : x.status === "low" ? 1 : 2;
    return danger(a)-danger(b) || a.name.localeCompare(b.name);
  });
  const lastPage = Math.max(1, Math.ceil(filtered.length/pageSize));
  const visiblePage = Math.min(lastPage,page);
  const rows = filtered.slice((visiblePage-1)*pageSize, visiblePage*pageSize);
  const canCount = canAccessPath(context, "/inventory/stocktake");
  const canSeeMovements = canAccessPath(context, "/inventory/movements");
  const canInvestigate = canAccessPath(context, "/inventory/reconciliation");
  const alerts = overview.rows.filter(row => ["negative","overbooked"].includes(row.status)).length;

  return <div dir={direction} className="space-y-4">
    <PageHeader
      title={tr("Storage", "المخزون")}
      subtitle={tr("What's physically on the shelves, what's reserved for routes, and what can be picked.", "الكميات الموجودة فعلياً في المخزن، والمحجوزة للجولات، والمتاحة للسحب.")}
      action={<div className="flex flex-wrap gap-2">
        <PrimaryButton href="/restock-priority/purchase-list">{tr("What to buy", "شن نشتري؟")}</PrimaryButton>
        {canCount ? <SecondaryButton href="/inventory/stocktake">{tr("Count stock", "جرد المخزن")}</SecondaryButton> : null}
      </div>}
    />
    {reservationWarning ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950">
      {tr(reservationWarning, "تعذر التأكد من حجوزات الجولات الحالية. تم إخفاء كمية المتاح للسحب بدلاً من عرض رقم غير صحيح.")}
    </p> : null}
    {alerts > 0 ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <span>{alerts} {tr("products have negative balances or more route reservations than physical stock. Review before picking.", "منتج لديه رصيد سالب أو حجوزات أكثر من المخزون الفعلي. راجعها قبل السحب.")}</span>
      {canInvestigate ? <Link href="/inventory/reconciliation" className="font-semibold underline">{tr("Investigate missing stock", "مراجعة الفروقات")}</Link> : null}
    </div> : null}
    <div className="grid grid-cols-3 gap-2" aria-label={tr("Storage summary", "ملخص المخزون")}>
      {[
        [tr("On shelves", "في المخزن"), overview.physicalUnits],
        [tr("Available", "متاح"), overview.availableUnits],
        [tr("Need attention", "للمتابعة"), overview.attentionProducts],
      ].map(([label,value])=><div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-2 py-3 text-center sm:px-4">
        <div className="text-xs font-medium text-slate-600">{label}</div>
        <div className="mt-1 text-xl font-bold text-slate-950 sm:text-2xl">{formatUnits(value as number | null, locale)}</div>
      </div>)}
    </div>
    <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <form action="/inventory" className="flex gap-2">
        {filter !== "stocked" ? <input type="hidden" name="filter" value={filter}/> : null}
        <div className="min-w-0 flex-1"><SearchInput defaultValue={q} placeholder={tr("Find a product or SKU", "ابحث عن المنتج أو الرمز")}/></div>
        <button type="submit" className="btn-secondary">{tr("Search", "بحث")}</button>
      </form>
      <nav aria-label={tr("Storage filters", "تصفية المخزون")} className="mt-3 flex gap-2 overflow-x-auto whitespace-nowrap pb-1">
        {filters.map(option => <Link key={option.key} href={stockPath(option.key, q)}
          aria-current={filter===option.key ? "page" : undefined}
          className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold ${
            filter===option.key ? "border-emerald-700 bg-emerald-800 text-white" : "border-slate-200 bg-white text-slate-600"
          }`}>
          {tr(option.en,option.ar)} <span className="text-xs opacity-75">{count(option.key)}</span>
        </Link>)}
      </nav>
    </section>
    {!filtered.length ? <EmptyState
      title={tr("Nothing in this view", "لا توجد منتجات في هذا العرض")}
      body={tr("Try another filter or search. Zero-stock products are available under All products.", "جرّب فلترًا أو بحثًا آخر. المنتجات التي رصيدها صفر موجودة تحت كل المنتجات.")}
      action={<SecondaryButton href="/inventory?filter=all">{tr("All products", "كل المنتجات")}</SecondaryButton>}
    /> : <>
      <MobileCardList>
        {rows.map(row => <MobileRecordCard key={row.productId}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><h2 className="break-words text-base font-semibold text-slate-950">{row.name}</h2>
              <p className="text-xs text-slate-500">{row.sku ?? tr("No SKU", "دون رمز")} {row.category ? `· ${row.category}` : ""}</p>
            </div>
            <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold ${statusStyles[row.status]}`}>{statusLabels[row.status][locale==="ar"?1:0]}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {([
              [tr("On shelf", "في المخزن"),row.physical,true],
              [tr("Reserved", "محجوز"),row.reserved,false],
              [tr("Available", "متاح"),row.available,false],
            ] as const).map(([label,value,isPhysical])=>
              <div key={label} className="rounded-lg bg-slate-50 px-2 py-3 text-center">
                <div className="text-xs text-slate-600">{label}</div>
                <div className="mt-1 text-lg font-bold tabular-nums text-slate-950">{formatUnits(value,locale)}</div>
                {isPhysical && packagingHint(row) ? <div className="mt-1 text-[10px] leading-tight text-slate-500">{packagingHint(row)}</div> : null}
              </div>)}
          </div>
          {row.reservations.length && overview.reservationsVerified ? <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <summary className="cursor-pointer text-sm font-medium text-amber-900">{tr("Reserved for routes", "محجوز للجولات")} ({row.reservations.length})</summary>
            <div className="mt-2 space-y-2">{row.reservations.map(reservation => <Link key={reservation.routeId}
              href={`/routes/${reservation.routeId}`} className="block rounded-lg bg-white px-3 py-2 text-sm underline">
              {tr("Route", "جولة")} {reservation.date ?? reservation.routeId.slice(0,8)} · {formatUnits(reservation.units,locale)} {tr("units", "وحدة")}
            </Link>)}</div>
          </details> : null}
        </MobileRecordCard>)}
      </MobileCardList>
      <DataTable className="hidden md:block" headers={[tr("Product","المنتج"),tr("On shelves","في المخزن"),tr("Reserved","محجوز"),tr("Available","متاح"),tr("Status","الحالة")]}>
        {rows.map(row => <tr key={row.productId}>
          <td className="font-semibold">{row.name}<div className="text-xs font-normal text-slate-500">{row.sku ?? "—"}</div></td>
          <td className="tabular-nums">{formatUnits(row.physical,locale)}{packagingHint(row) ? <div className="text-xs text-slate-500">{packagingHint(row)}</div> : null}</td>
          <td className="tabular-nums">{formatUnits(row.reserved,locale)}</td>
          <td className="tabular-nums">{formatUnits(row.available,locale)}</td>
          <td><span className={`rounded-full border px-2 py-1 text-xs font-semibold ${statusStyles[row.status]}`}>{statusLabels[row.status][locale==="ar"?1:0]}</span></td>
        </tr>)}
      </DataTable>
      <PaginationControls basePath="/inventory" searchParams={params} page={visiblePage} pageSize={pageSize} totalCount={filtered.length} itemLabel={tr("products","منتج")}/>
    </>}
    <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-200 pt-4 text-sm">
      {canSeeMovements ? <Link href="/inventory/movements" className="font-semibold text-emerald-800 underline underline-offset-2">{tr("View stock movement history", "عرض سجل حركات المخزون")}</Link> : null}
      {canInvestigate ? <Link href="/inventory/reconciliation" className="text-slate-600 underline underline-offset-2">{tr("Investigate stock differences", "التحقق من فروقات المخزون")}</Link> : null}
    </div>
    <p className="text-xs leading-5 text-slate-500">{tr(
      "Low stock is a shelf-level hint (10 units or a configured minimum), not a purchase recommendation. Use What to buy for sales-based quantities. Physical stock is never adjusted from this page.",
      "مؤشر الكمية القليلة يعتمد على 10 وحدات أو حد أدنى محدد، وليس كمية شراء مقترحة. استخدم «شن نشتري؟» لمعرفة الكميات بناءً على المبيعات. لا يتم تعديل المخزون من هذه الصفحة."
    )}</p>
  </div>;
}
