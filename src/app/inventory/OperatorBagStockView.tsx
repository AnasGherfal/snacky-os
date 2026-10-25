import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PaginationControls } from "@/components/PaginationControls";
import {
  DataTable, EmptyState, ErrorState, MobileCardList, MobileField,
  MobileRecordCard, PageHeader, SearchInput, SecondaryButton, StatusBadge,
} from "@/components/ui";
import { formatSignedProductQuantity } from "@/lib/product-quantity";
import { type SearchParamsRecord } from "@/lib/pagination";
import { safeSupabaseQuery } from "@/lib/safe-supabase-query";
import {
  normalizeOperatorBagBalances,
  type BagLedgerRow, type ProductPackagingRow, type BagDisplayRow,
} from "@/lib/operator-bag-stock";

const ROW_LIMIT = 5001;

function labelError(locale: string, english: string, arabic: string) {
  return locale === "ar" ? arabic : english;
}
function renderUnits(row: BagDisplayRow, ar: boolean) {
  return row.caseQuantity === null
    ? `${row.quantity.toLocaleString("en-US")} ${ar ? "وحدة" : "units"}`
    : formatSignedProductQuantity(row.quantity, {
        caseQuantity: row.caseQuantity,
        productName: row.productName,
        category: row.category,
      }, { compact: true });
}
function matchesBagSearch(row: BagDisplayRow, q: string) {
  const search = q.trim().toLowerCase();
  return !search || [row.productName, row.operatorName, row.sku, row.productId]
    .some((value) => String(value ?? "").toLowerCase().includes(search));
}

/**
 * Opened only through /inventory?view=operator-bags. The calling page already
 * checked inventory access. This read-only screen must never post ledger rows.
 */
export async function OperatorBagStockView({
  client, locale, q, page, pageSize, searchParams, canSeeMovementHistory,
}: {
  client: SupabaseClient;
  locale: string;
  q: string;
  page: number;
  pageSize: number;
  searchParams: SearchParamsRecord;
  canSeeMovementHistory: boolean;
}) {
  const tr = (en: string, ar: string) => labelError(locale, en, ar);
  const balances = await safeSupabaseQuery<BagLedgerRow>({
    label: "storage.operator-bag-custody",
    promise: client.from("current_inventory_by_location")
      .select("product_id, product_name, location_id, location_name, quantity_on_hand", { count: "exact" })
      .eq("location_type", "operator_bag")
      .order("location_name").order("product_name")
      .limit(ROW_LIMIT),
  });
  if (balances.error || balances.count !== balances.data.length || balances.data.length >= ROW_LIMIT) {
    return <ErrorState
      title={tr("Operator bag stock is unavailable", "تعذر تحميل مخزون حقائب المشغلين")}
      body={tr("The complete ledger balances could not be verified. No missing stock is treated as zero.", "تعذر التحقق من الأرصدة الكاملة في السجل. لن نعتبر المخزون المفقود صفراً.")}
      action={<SecondaryButton href="/inventory?view=operator-bags">{tr("Retry", "إعادة المحاولة")}</SecondaryButton>}
    />;
  }
  // Optional packaging details may fail independently; the signed unit count
  // is still trustworthy and stays visible with a clear warning.
  const packages = await safeSupabaseQuery<ProductPackagingRow>({
    label: "storage.operator-bag-product-packaging",
    promise: client.from("products")
      .select("id,sku,category,case_quantity", { count: "exact" })
      .order("id")
      .limit(ROW_LIMIT),
  });
  const packagingVerified = !packages.error && packages.count === packages.data.length && packages.data.length < ROW_LIMIT;
  const byProduct = packagingVerified ? new Map(packages.data.map((r) => [r.id, r])) : null;
  let records: BagDisplayRow[];
  try {
    records = normalizeOperatorBagBalances(balances.data, byProduct, locale === "ar");
  } catch (error) {
    console.error("[storage] Invalid operator bag ledger balance", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return <ErrorState
      title={tr("Operator bag quantities need review", "كميات حقائب المشغلين تحتاج مراجعة")}
      body={tr("One or more recorded balances is invalid. Check Data Health instead of assuming a zero quantity.", "هناك رصيد مسجّل غير صالح. راجع سلامة البيانات بدلاً من افتراض أن الكمية صفر.")}
      action={<SecondaryButton href="/inventory">{tr("Back to Storage", "العودة للمخزن")}</SecondaryButton>}
    />;
  }
  const packagingMissingCount = records.filter((r) => r.caseQuantity === null).length;
  const visible = records.filter((r) => matchesBagSearch(r, q));
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const rows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const negativeBalances = records.filter((r) => r.quantity < 0);
  const negativeCount = negativeBalances.length;
  const affectedOperators = new Set(negativeBalances.map((r) => r.operatorId)).size;
  const deficitUnits = negativeBalances.reduce((sum, r) => sum + Math.abs(r.quantity), 0);
  const operatorCount = new Set(records.map((r) => r.operatorId)).size;

  return <div dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader
      title={tr("Operator Bag Stock", "مخزون حقائب المشغلين")}
      subtitle={tr(
        "Recorded stock held by operators after route pickup. Compare it with returned goods or a physical count.",
        "الأرصدة المسجلة عند المشغلين بعد استلام بضاعة الجولات. طابقها مع الإرجاع والجرد الفعلي.",
      )}
      action={<SecondaryButton href="/inventory">{tr("Back to Storage", "العودة للمخزن")}</SecondaryButton>}
    />
    {negativeCount > 0 ? <section role="alert" aria-label={tr("Operator bag exceptions", "فروقات حقائب المشغلين")}
      className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
      <h2 className="font-semibold">{tr("Negative operator bag balances need investigation", "هناك أرصدة سالبة في حقائب المشغلين تحتاج تحقيقاً")}</h2>
      <p className="mt-1 text-xs text-rose-900">
        {negativeCount} {tr("products", "منتجات")} · {deficitUnits} {tr("units below zero", "وحدة أقل من الصفر")}
        {" · "}{affectedOperators} {tr("operator bags", "حقائب مشغلين")}
      </p>
      <p className="mt-2 text-xs leading-5">
        {tr("These are system ledger discrepancies, not proof of physical loss. Review pickups, fills and returns before adjusting anything.",
          "هذه فروقات في السجل وليست إثباتاً بفقدان بضاعة. راجع السحب والتعبئة والإرجاع قبل أي تعديل.")}
      </p>
      <div className="mt-3 space-y-2">
        {negativeBalances.map((r) => (
          <div key={`${r.operatorId}:${r.productId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-white p-2">
            <div className="min-w-0">
              <strong className="block break-words text-sm">{r.productName}</strong>
              <span className="text-xs text-rose-800">{r.operatorName} · {r.quantity} {tr("units", "وحدة")}</span>
            </div>
            {canSeeMovementHistory ? (
              <Link href={`/inventory/movements?product_id=${encodeURIComponent(r.productId)}&bag_id=${encodeURIComponent(r.operatorId)}`}
                className="text-xs font-semibold text-rose-900 underline underline-offset-2">
                {tr("Review ledger", "مراجعة السجل")}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </section> : null}
    {packagingMissingCount > 0 ? <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {tr("Packaging details are missing for some balances; those quantities are shown in units only.", "تنقص بيانات الصناديق لبعض الأرصدة؛ نعرض كمياتها بالوحدات فقط.")}
      {" "}({packagingMissingCount})
    </div> : null}
    <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-3 text-sm text-slate-600">{operatorCount} {tr("operators", "مشغّل")} · {visible.length} {tr("product balances", "رصيد منتجات")}</p>
      <form action="/inventory" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value="operator-bags" />
        <input type="hidden" name="pageSize" value={pageSize} />
        <div className="min-w-0 flex-1">
          <SearchInput defaultValue={q} placeholder={tr("Search operator, product or SKU", "ابحث عن المشغّل أو المنتج أو الرمز")} />
        </div>
        <button type="submit" className="btn-secondary">{tr("Search", "بحث")}</button>
        {q ? <Link href="/inventory?view=operator-bags" className="btn-secondary">{tr("Clear", "مسح")}</Link> : null}
      </form>
    </section>
    {!rows.length ? <EmptyState
      title={tr("No operator stock matches", "لا توجد أرصدة مطابقة")}
      body={tr("No operator bag balances match this search. Route pickups and returns are recorded in the movement ledger.", "لا توجد أرصدة حقائب مطابقة. السحب والإرجاع مسجلان في سجل الحركات.")}
    /> : <>
      <MobileCardList>{rows.map((r) => <MobileRecordCard key={`${r.operatorId}:${r.productId}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="break-words font-semibold text-slate-950">{r.productName}</h2>
            <p className="mt-1 text-sm text-slate-600">{r.operatorName}</p>
          </div>
          {r.quantity < 0 ? <StatusBadge status="review" label={tr("Review", "مراجعة")} /> : null}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <MobileField label={tr("Recorded quantity", "الكمية المسجلة")}>{renderUnits(r, locale === "ar")}</MobileField>
          <MobileField label={tr("SKU", "الرمز")}>{r.sku ?? "—"}</MobileField>
        </div>
        {canSeeMovementHistory ? (
          <Link href={`/inventory/movements?product_id=${encodeURIComponent(r.productId)}&bag_id=${encodeURIComponent(r.operatorId)}`}
            className="mt-3 inline-block text-sm font-semibold text-emerald-800 underline underline-offset-2">
            {tr("Inspect movement history", "مراجعة حركات المنتج")}
          </Link>
        ) : null}
      </MobileRecordCard>)}</MobileCardList>
      <DataTable className="hidden md:block" headers={[
        tr("Operator", "المشغّل"), tr("Product", "المنتج"),
        tr("SKU", "الرمز"), tr("Recorded quantity", "الكمية المسجلة"),
      ]}>{rows.map((r) => <tr key={`${r.operatorId}:${r.productId}`}>
        <td>{r.operatorName}</td><td>
          <div>{r.productName}</div>
          {canSeeMovementHistory ? <Link
            href={`/inventory/movements?product_id=${encodeURIComponent(r.productId)}&bag_id=${encodeURIComponent(r.operatorId)}`}
            className="text-xs font-semibold text-emerald-800 underline underline-offset-2">
            {tr("Movement history", "سجل الحركات")}
          </Link> : null}
        </td><td>{r.sku ?? "—"}</td>
        <td className={r.quantity < 0 ? "font-semibold text-rose-800" : "font-semibold"}>
          {renderUnits(r, locale === "ar")}
        </td>
      </tr>)}</DataTable>
    </>}
    <PaginationControls basePath="/inventory" searchParams={searchParams}
      page={currentPage} pageSize={pageSize} totalCount={visible.length}
      itemLabel={tr("operator product balances", "أرصدة منتجات المشغلين")} />
    {canSeeMovementHistory ? <div className="mt-4">
      <SecondaryButton href="/inventory/movements">{tr("Open Movement Log", "فتح سجل الحركات")}</SecondaryButton>
    </div> : null}
  </div>;
}
