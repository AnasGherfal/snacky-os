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

const ROW_LIMIT = 5001;

type BagLedgerRow = {
  product_id: string | null;
  product_name: string | null;
  location_id: string | null;
  location_name: string | null;
  quantity_on_hand: number | string | null;
};
type ProductPackagingRow = {
  id: string;
  sku: string | null;
  category: string | null;
  case_quantity: number | null;
};
type BagDisplayRow = {
  productId: string;
  productName: string;
  operatorId: string;
  operatorName: string;
  sku: string | null;
  quantity: number;
  category: string | null;
  caseQuantity: number | null;
};
function labelError(locale: string, english: string, arabic: string) {
  return locale === "ar" ? arabic : english;
}
function renderUnits(row: BagDisplayRow) {
  return row.caseQuantity === null
    ? `${row.quantity.toLocaleString("en-US")} units`
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
  client, locale, q, page, pageSize, searchParams,
}: {
  client: SupabaseClient;
  locale: string;
  q: string;
  page: number;
  pageSize: number;
  searchParams: SearchParamsRecord;
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
  const invalid = balances.data.some((row) =>
    !row.product_id || !row.location_id
    || row.quantity_on_hand === null
    || !Number.isSafeInteger(Number(row.quantity_on_hand))
  );
  if (invalid) {
    return <ErrorState
      title={tr("Operator bag quantities need review", "كميات حقائب المشغلين تحتاج مراجعة")}
      body={tr("One or more recorded balances is invalid. Open Data Health rather than assuming a zero quantity.", "هناك رصيد مسجّل غير صالح. راجع سلامة البيانات بدلاً من افتراض أن الكمية صفر.")}
      action={<SecondaryButton href="/inventory">{tr("Back to Storage", "العودة للمخزن")}</SecondaryButton>}
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
  const byProduct = new Map((packagingVerified ? packages.data : []).map((r) => [r.id, r]));
  const records: BagDisplayRow[] = balances.data
    .filter((r) => Number(r.quantity_on_hand) !== 0)
    .map((r) => {
      const product = byProduct.get(String(r.product_id));
      return {
        productId: String(r.product_id),
        productName: r.product_name ?? tr("Unknown product", "منتج غير معروف"),
        operatorId: String(r.location_id),
        operatorName: r.location_name ?? tr("Unassigned operator", "مشغّل غير محدد"),
        sku: product?.sku ?? null,
        quantity: Number(r.quantity_on_hand),
        category: product?.category ?? null,
        caseQuantity: packagingVerified ? (product?.case_quantity ?? 1) : null,
      };
    })
    .sort((a, b) => a.operatorName.localeCompare(b.operatorName) || a.productName.localeCompare(b.productName));

  const visible = records.filter((r) => matchesBagSearch(r, q));
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const rows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const negativeCount = records.filter((r) => r.quantity < 0).length;
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
    {negativeCount > 0 ? <div role="alert" className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
      {tr("Negative operator bag balances need investigation", "هناك أرصدة سالبة في حقائب المشغلين تحتاج تحقيقاً")}: {negativeCount}
    </div> : null}
    {!packagingVerified ? <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {tr("Packaging details are unavailable; balances are shown in units only.", "بيانات الصناديق غير متاحة؛ نعرض الأرصدة بالوحدات فقط.")}
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
          <MobileField label={tr("Recorded quantity", "الكمية المسجلة")}>{renderUnits(r)}</MobileField>
          <MobileField label={tr("SKU", "الرمز")}>{r.sku ?? "—"}</MobileField>
        </div>
      </MobileRecordCard>)}</MobileCardList>
      <DataTable className="hidden md:block" headers={[
        tr("Operator", "المشغّل"), tr("Product", "المنتج"),
        tr("SKU", "الرمز"), tr("Recorded quantity", "الكمية المسجلة"),
      ]}>{rows.map((r) => <tr key={`${r.operatorId}:${r.productId}`}>
        <td>{r.operatorName}</td><td>{r.productName}</td><td>{r.sku ?? "—"}</td>
        <td className={r.quantity < 0 ? "font-semibold text-rose-800" : "font-semibold"}>
          {renderUnits(r)}
        </td>
      </tr>)}</DataTable>
    </>}
    <PaginationControls basePath="/inventory" searchParams={searchParams}
      page={currentPage} pageSize={pageSize} totalCount={visible.length}
      itemLabel={tr("operator product balances", "أرصدة منتجات المشغلين")} />
    <div className="mt-4">
      <SecondaryButton href="/inventory/movements">{tr("Open Movement Log", "فتح سجل الحركات")}</SecondaryButton>
    </div>
  </div>;
}
