/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatProductQuantity } from "@/lib/product-quantity";
import {
  calculateSimpleStockCheck,
  simpleStockCheckExplanation,
  simpleStockCheckStatusLabel,
  simpleStockCheckStatusTone,
} from "@/lib/simple-stock-check";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string; product?: string };

type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  case_quantity: number | string | null;
  cost_price: number | string | null;
  current_cost_price_lyd: number | string | null;
  last_purchase_cost_lyd: number | string | null;
  average_cost_lyd: number | string | null;
};

type MonthlyBatchRow = {
  id: string;
  report_start_date: string | null;
  report_end_date: string | null;
  imported_at: string | null;
  uploaded_at: string | null;
};

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value: unknown) {
  return Math.max(0, Math.floor(numeric(value)));
}

function dateOnly(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function currentMonthRange() {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    month: startDate.toISOString().slice(0, 7),
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
    today: now.toISOString().slice(0, 10),
  };
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectLatestMonthlyBatch(rows: MonthlyBatchRow[]) {
  return [...rows].sort((left, right) => {
    const end = String(dateOnly(right.report_end_date) ?? "").localeCompare(String(dateOnly(left.report_end_date) ?? ""));
    if (end) return end;
    return Math.max(timestamp(right.imported_at), timestamp(right.uploaded_at)) - Math.max(timestamp(left.imported_at), timestamp(left.uploaded_at));
  })[0] ?? null;
}

function quantity(value: unknown, product: ProductRow) {
  return formatProductQuantity(value, {
    caseQuantity: Math.max(1, whole(product.case_quantity) || 1),
    productName: product.name,
    category: product.category,
  }, { compact: true });
}

function formatSnapshotTime(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default async function MonthlyStockCheckPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireCurrentProfileForPath("/inventory/stock-check");
  const params = await searchParams;
  const q = String(params.q ?? "").trim().toLowerCase();
  const selectedProductId = String(params.product ?? "").trim();
  const range = currentMonthRange();
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) return <ErrorState title="Stock Check unavailable" body="Supabase is not configured." />;

  const [productsResult, inventoryResult, machineStockResult, machinesResult, purchasesResult, batchesResult, lossesResult] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, sku, category, case_quantity, cost_price, current_cost_price_lyd, last_purchase_cost_lyd, average_cost_lyd")
      .eq("active", true)
      .order("name")
      .limit(5000),
    supabase
      .from("current_inventory_by_location")
      .select("product_id, location_type, location_id, location_name, quantity_on_hand")
      .in("location_type", ["storage", "operator_bag"])
      .limit(20000),
    supabase
      .from("latest_vms_stock_by_slot")
      .select("machine_id, product_id, current_qty, captured_at")
      .not("product_id", "is", null)
      .limit(30000),
    supabase
      .from("machines")
      .select("id, name, machine_code, status")
      .limit(5000),
    supabase
      .from("purchase_orders")
      .select("id, order_date, received_date, status, purchase_order_lines(product_id, total_units, received_qty, line_total_lyd, unit_cost_lyd)")
      .gte("order_date", range.start)
      .lte("order_date", range.today)
      .limit(5000),
    supabase
      .from("vms_import_batches")
      .select("id, report_start_date, report_end_date, imported_at, uploaded_at")
      .eq("report_type", "monthly_product_profit")
      .in("status", ["imported", "imported_with_warnings", "partially_imported"])
      .eq("is_active", true)
      .is("deleted_at", null)
      .lte("report_start_date", range.end)
      .gte("report_end_date", range.start)
      .limit(100),
    supabase
      .from("inventory_movements")
      .select("product_id, quantity, reason, from_entity_type, to_entity_type, created_at")
      .gte("created_at", `${range.start}T00:00:00.000Z`)
      .lt("created_at", `${new Date(Date.parse(`${range.today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`)
      .limit(20000),
  ]);

  const loadError = productsResult.error ?? inventoryResult.error ?? machineStockResult.error ?? purchasesResult.error ?? batchesResult.error;
  if (loadError) {
    console.error("[monthly-stock-check] Could not load stock check data", loadError);
    return <ErrorState title="Stock Check could not load" body="Snacky OS could not load products, purchases, sales, or current stock." />;
  }

  const currentBatch = selectLatestMonthlyBatch((batchesResult.data ?? []) as MonthlyBatchRow[]);
  const salesThrough = dateOnly(currentBatch?.report_end_date);
  const monthlySalesResult = currentBatch
    ? await supabase
        .from("vms_monthly_product_profit")
        .select("internal_product_id, transaction_count, import_batch_id")
        .eq("import_batch_id", currentBatch.id)
        .limit(30000)
    : { data: [], error: null };

  const fallbackSalesResult = !currentBatch || monthlySalesResult.error || !(monthlySalesResult.data ?? []).length
    ? await supabase
        .from("kpi_product_monthly")
        .select("product_id, units_sold, sales_month")
        .eq("sales_month", `${range.month}-01`)
        .limit(10000)
    : { data: [], error: null };

  const products = (productsResult.data ?? []) as ProductRow[];
  const storageByProduct = new Map<string, number>();
  const operatorByProduct = new Map<string, number>();
  (inventoryResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    const target = row.location_type === "operator_bag" ? operatorByProduct : storageByProduct;
    target.set(productId, (target.get(productId) ?? 0) + whole(row.quantity_on_hand));
  });

  const machinesById = new Map((machinesResult.data ?? []).map((machine: any) => [String(machine.id), machine]));
  const machineByProduct = new Map<string, number>();
  const machineBreakdownByProduct = new Map<string, Array<{ machineId: string; machineName: string; machineCode: string; quantity: number; capturedAt: string | null }>>();
  const groupedMachineRows = new Map<string, { productId: string; machineId: string; quantity: number; capturedAt: string | null }>();
  (machineStockResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    const machineId = String(row.machine_id ?? "");
    if (!productId || !machineId) return;
    const key = `${productId}:${machineId}`;
    const current = groupedMachineRows.get(key) ?? { productId, machineId, quantity: 0, capturedAt: null };
    current.quantity += whole(row.current_qty);
    if (timestamp(row.captured_at) > timestamp(current.capturedAt)) current.capturedAt = row.captured_at ?? null;
    groupedMachineRows.set(key, current);
  });
  groupedMachineRows.forEach((row) => {
    machineByProduct.set(row.productId, (machineByProduct.get(row.productId) ?? 0) + row.quantity);
    const machine = machinesById.get(row.machineId) as any;
    machineBreakdownByProduct.set(row.productId, [
      ...(machineBreakdownByProduct.get(row.productId) ?? []),
      {
        machineId: row.machineId,
        machineName: String(machine?.name ?? "Unknown machine"),
        machineCode: String(machine?.machine_code ?? "-"),
        quantity: row.quantity,
        capturedAt: row.capturedAt,
      },
    ]);
  });

  const boughtByProduct = new Map<string, { units: number; spend: number }>();
  (purchasesResult.data ?? [])
    .filter((purchase: any) => ["received", "completed", "partially_received"].includes(String(purchase.status ?? "").toLowerCase()))
    .forEach((purchase: any) => {
      (purchase.purchase_order_lines ?? []).forEach((line: any) => {
        const productId = String(line.product_id ?? "");
        if (!productId) return;
        const totalUnits = whole(line.total_units);
        const receivedQty = whole(line.received_qty);
        const units = receivedQty > 0 ? receivedQty : totalUnits;
        const current = boughtByProduct.get(productId) ?? { units: 0, spend: 0 };
        current.units += units;
        current.spend += Math.max(0, numeric(line.line_total_lyd, units * numeric(line.unit_cost_lyd)));
        boughtByProduct.set(productId, current);
      });
    });

  const soldByProduct = new Map<string, number>();
  if ((monthlySalesResult.data ?? []).length) {
    (monthlySalesResult.data ?? []).forEach((row: any) => {
      const productId = String(row.internal_product_id ?? "");
      if (!productId) return;
      soldByProduct.set(productId, (soldByProduct.get(productId) ?? 0) + whole(row.transaction_count));
    });
  } else {
    (fallbackSalesResult.data ?? []).forEach((row: any) => {
      const productId = String(row.product_id ?? "");
      if (!productId) return;
      soldByProduct.set(productId, (soldByProduct.get(productId) ?? 0) + whole(row.units_sold));
    });
  }

  const lossesByProduct = new Map<string, number>();
  (lossesResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    const reason = String(row.reason ?? "").toLowerCase();
    const fromInternal = ["storage", "operator_bag", "machine"].includes(String(row.from_entity_type ?? ""));
    const toInternal = ["storage", "operator_bag", "machine"].includes(String(row.to_entity_type ?? ""));
    const recordedLoss = ["damaged", "expired", "theft_or_missing"].includes(reason) || (fromInternal && !toInternal);
    if (recordedLoss) lossesByProduct.set(productId, (lossesByProduct.get(productId) ?? 0) + whole(row.quantity));
  });

  const rows = products.map((product) => {
    const bought = boughtByProduct.get(product.id) ?? { units: 0, spend: 0 };
    const result = calculateSimpleStockCheck({
      boughtUnits: bought.units,
      soldUnits: soldByProduct.get(product.id) ?? 0,
      recordedLossUnits: lossesByProduct.get(product.id) ?? 0,
      storageUnits: storageByProduct.get(product.id) ?? 0,
      machineUnits: machineByProduct.get(product.id) ?? 0,
      operatorUnits: operatorByProduct.get(product.id) ?? 0,
    });
    const unitCost = Math.max(0, numeric(product.last_purchase_cost_lyd ?? product.average_cost_lyd ?? product.current_cost_price_lyd ?? product.cost_price));
    return {
      product,
      boughtSpend: bought.spend,
      unitCost,
      possibleMissingCost: result.possibleMissingUnits * unitCost,
      machineBreakdown: (machineBreakdownByProduct.get(product.id) ?? []).sort((a, b) => b.quantity - a.quantity || a.machineName.localeCompare(b.machineName)),
      ...result,
    };
  })
    .filter((row) => row.boughtUnits > 0 || row.soldUnits > 0 || row.recordedLossUnits > 0 || row.currentTotalUnits > 0)
    .filter((row) => !q || [row.product.name, row.product.sku, row.product.category].some((value) => String(value ?? "").toLowerCase().includes(q)))
    .sort((left, right) => right.possibleMissingUnits - left.possibleMissingUnits || right.soldUnits - left.soldUnits || left.product.name.localeCompare(right.product.name));

  const selectedRow = rows.find((row) => row.product.id === selectedProductId) ?? null;
  const totals = rows.reduce((sum, row) => ({
    bought: sum.bought + row.boughtUnits,
    sold: sum.sold + row.soldUnits,
    storage: sum.storage + row.storageUnits,
    machines: sum.machines + row.machineUnits,
    operator: sum.operator + row.operatorUnits,
    possibleMissing: sum.possibleMissing + row.possibleMissingUnits,
    possibleMissingCost: sum.possibleMissingCost + row.possibleMissingCost,
  }), { bought: 0, sold: 0, storage: 0, machines: 0, operator: 0, possibleMissing: 0, possibleMissingCost: 0 });

  const salesSource = currentBatch ? "Monthly Product Profit" : (fallbackSalesResult.data ?? []).length ? "Detailed VMS sales" : "No current-month sales file";

  return (
    <>
      <PageHeader
        title="This Month Stock Check"
        subtitle="A simple view of what Snacky bought this month, what VMS says was sold, and what is currently left in storage, machines, and operator stock."
        breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Stock Check" }]}
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/purchases">Purchases</SecondaryButton><SecondaryButton href="/inventory/reconciliation">Advanced exact reconciliation</SecondaryButton></div>}
      />

      <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        <div className="font-semibold">The simple calculation</div>
        <p className="mt-1"><strong>Bought − sold − recorded losses</strong> gives the balance left from this month’s buying. Snacky compares it with <strong>storage now + machines now + operator stock</strong>.</p>
        <p className="mt-2 text-xs leading-5">“Possible missing” means current visible stock is lower than the balance from this month’s purchases. It is not final proof when stock already existed before this month; the advanced page is only needed when you want a fully exact audit.</p>
      </div>

      <section className="surface-card mb-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{range.month} through {salesThrough ?? range.today}</h2>
            <p className="mt-1 text-sm text-slate-500">Sales source: {salesSource}. Machine quantities use each slot’s latest VMS stock snapshot.</p>
          </div>
          <form action="/inventory/stock-check" className="flex gap-2">
            <input name="q" className="field-input" defaultValue={params.q ?? ""} placeholder="Search product..." />
            <button className="btn-secondary" type="submit">Search</button>
          </form>
        </div>
      </section>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Bought this month" value={totals.bought.toLocaleString()} helper="Only received purchases" />
        <Metric label="Sold this month" value={totals.sold.toLocaleString()} helper={`VMS through ${salesThrough ?? "latest available data"}`} />
        <Metric label="Storage now" value={totals.storage.toLocaleString()} />
        <Metric label="Machines now" value={totals.machines.toLocaleString()} />
        <Metric label="Operator stock" value={totals.operator.toLocaleString()} />
        <Metric label="Possible missing" value={totals.possibleMissing.toLocaleString()} helper={lyd(totals.possibleMissingCost)} tone={totals.possibleMissing > 0 ? "danger" : "default"} />
      </div>

      <section className="surface-card mb-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-950">Products</h2>
          <p className="mt-1 text-sm text-slate-500">Start with the red “possible missing” rows. Click a product to see exactly what is currently inside each machine.</p>
        </div>
        {!rows.length ? (
          <EmptyState title="No monthly stock activity" body="No received purchases, current-month sales, or current stock matched this view." />
        ) : (
          <DataTable sortable showSummary headers={["Product", "Bought", "Sold", "Recorded loss", "Left from this month buying", "Storage now", "Machines now", "Operator", "Current total", "Possible missing", "Possible missing cost", "Result"]}>
            {rows.map((row) => (
              <tr key={row.product.id}>
                <td>
                  <Link href={`/inventory/stock-check?product=${encodeURIComponent(row.product.id)}${params.q ? `&q=${encodeURIComponent(params.q)}` : ""}`} className="font-semibold text-slate-950 hover:underline">{row.product.name}</Link>
                  <div className="text-xs text-slate-500">{row.product.sku ?? "No SKU"} · {row.product.category ?? "Uncategorized"}</div>
                </td>
                <td>{quantity(row.boughtUnits, row.product)}</td>
                <td>{quantity(row.soldUnits, row.product)}</td>
                <td>{quantity(row.recordedLossUnits, row.product)}</td>
                <td className="font-semibold">{quantity(row.remainingFromThisMonthsPurchases, row.product)}</td>
                <td>{quantity(row.storageUnits, row.product)}</td>
                <td>{quantity(row.machineUnits, row.product)}</td>
                <td>{quantity(row.operatorUnits, row.product)}</td>
                <td className="font-semibold">{quantity(row.currentTotalUnits, row.product)}</td>
                <td className={row.possibleMissingUnits > 0 ? "font-semibold text-rose-700" : ""}>{quantity(row.possibleMissingUnits, row.product)}</td>
                <td>{lyd(row.possibleMissingCost)}</td>
                <td><StatusBadge status={simpleStockCheckStatusTone(row.status)} label={simpleStockCheckStatusLabel(row.status)} /><div className="mt-1 max-w-xs text-xs text-slate-500">{simpleStockCheckExplanation(row.status)}</div></td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      {selectedRow ? (
        <section className="surface-card mb-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{selectedRow.product.name} by machine</h2>
              <p className="mt-1 text-sm text-slate-500">Latest VMS stock currently visible in each machine.</p>
            </div>
            <Link href={`/inventory/stock-check${params.q ? `?q=${encodeURIComponent(params.q)}` : ""}`} className="btn-secondary">Close detail</Link>
          </div>
          {!selectedRow.machineBreakdown.length ? (
            <div className="mt-4"><EmptyState title="No machine stock found" body="This product has no mapped quantity in the latest machine-stock snapshot." /></div>
          ) : (
            <div className="mt-4">
              <DataTable headers={["Machine", "Code", "Quantity now", "Snapshot time"]}>
                {selectedRow.machineBreakdown.map((machine) => (
                  <tr key={machine.machineId}>
                    <td className="font-semibold">{machine.machineName}</td>
                    <td>{machine.machineCode}</td>
                    <td>{quantity(machine.quantity, selectedRow.product)}</td>
                    <td>{formatSnapshotTime(machine.capturedAt)}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

function Metric({ label, value, helper, tone = "default" }: { label: string; value: string; helper?: string; tone?: "default" | "danger" }) {
  return (
    <div className={`surface-card ${tone === "danger" ? "border-rose-200" : ""}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${tone === "danger" ? "text-rose-700" : "text-slate-950"}`}>{value}</div>
      {helper ? <p className="mt-1 text-sm text-slate-500">{helper}</p> : null}
    </div>
  );
}
