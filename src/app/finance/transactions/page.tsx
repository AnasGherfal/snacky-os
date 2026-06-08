import Link from "next/link";
import { redirect } from "next/navigation";
import { Fragment } from "react";
import { PaginationControls } from "@/components/PaginationControls";
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canEditFinancialTransactions, canViewFinancials } from "@/lib/authz";
import {
  accountLabel,
  formatFinanceMoney,
  isBalanceAffectingTransaction,
  signedAmount,
} from "@/lib/finance-balance";
import {
  cleanSearchParams,
  getPagination,
  SearchParamsRecord,
  supabaseLikePattern,
} from "@/lib/pagination";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type TransactionParams = SearchParamsRecord & {
  q?: string;
  review?: string;
  direction?: string;
  kind?: string;
  status?: string;
  group_product_purchases?: string;
  date_from?: string;
  date_to?: string;
  saved?: string;
  error?: string;
};

const FINANCE_TRANSACTIONS_TABLE = "financial_transactions";

const FINANCE_TRANSACTION_FULL_COLUMNS = [
  "id",
  "transaction_date",
  "transaction_datetime",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "notes",
  "amount",
  "signed_amount",
  "currency",
  "account_id",
  "account_key",
  "transaction_effect",
  "source_account_id",
  "destination_account_id",
  "import_status",
  "category",
  "final_bucket",
  "payment_method",
  "transaction_status",
  "review_status",
  "needs_review",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "linked_purchase_id",
  "source_type",
  "source_id",
  "related_cash_collection_id",
  "linked_cash_collection_id",
  "related_route_id",
  "related_machine_id",
  "related_location_id",
  "receipt_url",
  "counterparty_text",
  "payer_text",
  "paid_to_text",
  "is_void",
  "voided_at",
  "void_reason",
  "created_at",
  "updated_at",
  "created_by",
];

const FINANCE_TRANSACTION_STABLE_COLUMNS = [
  "id",
  "transaction_date",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "notes",
  "amount",
  "signed_amount",
  "currency",
  "account_id",
  "transaction_effect",
  "source_account_id",
  "destination_account_id",
  "import_status",
  "final_bucket",
  "payment_method",
  "transaction_status",
  "review_status",
  "needs_review",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "related_cash_collection_id",
  "linked_cash_collection_id",
  "related_route_id",
  "related_machine_id",
  "related_location_id",
  "receipt_url",
  "created_at",
];

const FINANCE_TRANSACTION_MINIMAL_COLUMNS = [
  "id",
  "transaction_date",
  "direction",
  "transaction_kind",
  "transaction_type",
  "location",
  "description",
  "amount",
  "signed_amount",
  "bucket",
  "final_bucket",
  "review_status",
  "needs_review",
  "source_sheet",
  "source_row",
  "related_purchase_id",
  "related_cash_collection_id",
  "created_by",
  "created_at",
  "updated_at",
];

function canAccess(profile: Awaited<ReturnType<typeof getCurrentProfile>>) {
  return (
    profile &&
    canViewFinancials({
      id: profile.id,
      role: profile.role,
      roles: profile.roles,
      canAddProducts: profile.can_add_products,
      teamMemberId: profile.team_member_id,
      activeStatus: profile.active_status,
    })
  );
}

function categoryLabel(row: any) {
  return (
    row.category ??
    row.final_bucket ??
    row.transaction_type ??
    row.bucket ??
    String(row.transaction_kind ?? "transaction").replaceAll("_", " ")
  );
}

function paymentLabel(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "-";
}

function sourceLabel(row: any) {
  if (relatedPurchaseId(row) || row.source_type === "purchase")
    return "Purchase";
  if (relatedCashCollectionId(row) || row.source_type === "cash_collection")
    return "Cash Collection";
  if (row.source_type === "import" || row.source_sheet) return "Import";
  if (row.source_type) return String(row.source_type).replaceAll("_", " ");
  return "Manual";
}

function isProductPurchaseRow(row: any) {
  const category = String(
    row.category ?? row.final_bucket ?? row.transaction_type ?? "",
  )
    .trim()
    .toLowerCase();
  return (
    row.direction === "money_out" &&
    (row.transaction_kind === "product_purchase" ||
      row.source_type === "purchase" ||
      Boolean(row.linked_purchase_id) ||
      category === "products restocking")
  );
}

function isActiveProductPurchaseRow(row: any) {
  return (
    isProductPurchaseRow(row) && normalizedTransactionStatus(row) === "active"
  );
}

function groupKey(row: any) {
  return `product-purchases-${row.transaction_date}`;
}

function groupAnchor(key: string) {
  return key.replace(/[^a-z0-9-]/gi, "-");
}

function paymentSummary(rows: any[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const method = String(row.payment_method ?? "").trim();
    if (!method) continue;
    const label = paymentLabel(method);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!counts.size) return "-";
  return Array.from(counts.entries())
    .map(([method, count]) => (count > 1 ? `${method} (${count})` : method))
    .join(", ");
}

function relatedPurchaseId(row: any) {
  return (
    row.related_purchase_id ??
    row.linked_purchase_id ??
    (row.source_type === "purchase" ? row.source_id : null)
  );
}

function relatedCashCollectionId(row: any) {
  return (
    row.related_cash_collection_id ??
    row.linked_cash_collection_id ??
    (row.source_type === "cash_collection" ? row.source_id : null)
  );
}

function purchaseFor(row: any, purchases: Map<string, any>) {
  const purchaseId = relatedPurchaseId(row);
  return purchaseId ? purchases.get(purchaseId) : null;
}

function normalizedTransactionStatus(row: any) {
  if (row.is_void || row.voided_at) return "voided";
  return row.transaction_status ?? "active";
}

function accountKeyFor(row: any) {
  return (
    row.account_key ?? row.account_id ?? row.source_account_id ?? "snacky_lyd"
  );
}

function sourceHref(row: any) {
  const purchaseId = relatedPurchaseId(row);
  if (purchaseId) return `/purchases/${purchaseId}`;
  const cashCollectionId = relatedCashCollectionId(row);
  if (cashCollectionId) return `/cash-collections/${cashCollectionId}`;
  return null;
}

function normalizeFinanceTransactionRow(row: any) {
  const amount = Math.abs(Number(row.amount ?? row.signed_amount ?? 0));
  const direction = row.direction === "money_in" ? "money_in" : "money_out";
  const signed = Number.isFinite(Number(row.signed_amount))
    ? Number(row.signed_amount)
    : direction === "money_out"
      ? -amount
      : amount;
  return {
    ...row,
    amount,
    signed_amount: signed,
    currency: row.currency ?? "LYD",
    account_key: accountKeyFor(row),
    category: categoryLabel(row),
    transaction_status: normalizedTransactionStatus(row),
  };
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvDataHref(headers: string[], rows: unknown[][]) {
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

function relatedLabel(
  row: any,
  maps: {
    purchases: Map<string, any>;
    routes: Map<string, any>;
    machines: Map<string, any>;
    locations: Map<string, any>;
  },
) {
  const items = [];
  const purchase = purchaseFor(row, maps.purchases);
  const route = row.related_route_id
    ? maps.routes.get(row.related_route_id)
    : null;
  const machine = row.related_machine_id
    ? maps.machines.get(row.related_machine_id)
    : null;
  const location = row.related_location_id
    ? maps.locations.get(row.related_location_id)
    : null;

  if (purchase)
    items.push(
      <Link
        key="purchase"
        href={`/purchases/${purchase.id}`}
        className="link-secondary"
      >
        Purchase {purchase.receipt_number ?? purchase.id.slice(0, 8)}
      </Link>,
    );
  if (route)
    items.push(
      <Link key="route" href={`/routes/${route.id}`} className="link-secondary">
        Route {route.route_date}
      </Link>,
    );
  if (machine)
    items.push(
      <Link
        key="machine"
        href={`/machines/${machine.id}/edit`}
        className="link-secondary"
      >
        {machine.name ?? machine.machine_code}
      </Link>,
    );
  if (location)
    items.push(
      <Link
        key="location"
        href={`/locations/${location.id}`}
        className="link-secondary"
      >
        {location.name}
      </Link>,
    );
  const cashCollectionId = relatedCashCollectionId(row);
  if (cashCollectionId)
    items.push(
      <Link
        key="cash"
        href={`/cash-collections/${cashCollectionId}`}
        className="link-secondary"
      >
        Cash collection
      </Link>,
    );

  return items.length ? (
    <div className="flex flex-col gap-1">{items}</div>
  ) : (
    <span className="text-slate-400">-</span>
  );
}

async function fetchByIds(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  table: string,
  select: string,
  ids: string[],
) {
  if (!ids.length) return [];
  const { data } = await supabase
    .from(table)
    .select(select)
    .in("id", Array.from(new Set(ids)));
  return data ?? [];
}

function supabaseErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      code: null,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
      details: null,
      hint: null,
    };
  }
  const row = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return {
    code: row.code ?? null,
    message:
      row.message ??
      (error instanceof Error ? error.message : "Unknown database error"),
    details: row.details ?? null,
    hint: row.hint ?? null,
  };
}

function errorText(error: unknown) {
  const details = supabaseErrorDetails(error);
  return [details.code, details.message, details.details, details.hint]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
}

function missingColumnFromError(error: unknown, selectedColumns: string[]) {
  const text = errorText(error);
  return (
    selectedColumns.find((column) => text.includes(column.toLowerCase())) ??
    null
  );
}

function isColumnOrSchemaError(error: unknown) {
  const text = errorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    text.includes("schema cache") ||
    (text.includes("column") && text.includes("does not exist"))
  );
}

function isPermissionError(error: unknown) {
  const text = errorText(error);
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return (
    code === "42501" ||
    text.includes("permission denied") ||
    text.includes("row-level security") ||
    text.includes("rls")
  );
}

async function financeLedgerDiagnostics({
  supabase,
  profile,
  canEdit,
  selectedColumns,
  error,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  profile: NonNullable<Awaited<ReturnType<typeof getCurrentProfile>>>;
  canEdit: boolean;
  selectedColumns: string[];
  error: unknown;
}) {
  const authResult = await supabase.auth.getUser();
  return {
    table: FINANCE_TRANSACTIONS_TABLE,
    selected_columns: selectedColumns,
    missing_column: missingColumnFromError(error, selectedColumns),
    supabase_error: supabaseErrorDetails(error),
    current_user_id: authResult.data.user?.id ?? profile.id ?? null,
    auth_error: authResult.error
      ? supabaseErrorDetails(authResult.error)
      : null,
    profile_id: profile.id ?? null,
    team_member_id: profile.team_member_id ?? null,
    effective_permissions: {
      role: profile.role ?? null,
      roles: profile.roles ?? [],
      can_view_financials: canAccess(profile),
      can_edit_financial_transactions: canEdit,
      active_status: profile.active_status ?? null,
    },
  };
}

function applyFinanceTransactionFilters({
  query,
  params,
  statusFilter,
  search,
  matchingPurchaseIds,
  level,
}: {
  query: any;
  params: TransactionParams;
  statusFilter: string;
  search: string;
  matchingPurchaseIds: string[];
  level: "full" | "stable" | "minimal";
}) {
  let nextQuery = query;
  if (statusFilter !== "all" && level !== "minimal") {
    nextQuery =
      statusFilter === "active"
        ? nextQuery.or("transaction_status.eq.active,transaction_status.is.null")
        : nextQuery.eq("transaction_status", statusFilter);
  }
  if (params.review === "needs_review")
    nextQuery = nextQuery.eq("needs_review", true);
  if (params.review === "confirmed")
    nextQuery = nextQuery.eq("review_status", "confirmed");
  if (params.review === "reviewed")
    nextQuery = nextQuery.eq("review_status", "reviewed");
  if (params.direction) nextQuery = nextQuery.eq("direction", params.direction);
  if (params.kind) nextQuery = nextQuery.eq("transaction_kind", params.kind);
  if (params.date_from)
    nextQuery = nextQuery.gte("transaction_date", params.date_from);
  if (params.date_to)
    nextQuery = nextQuery.lte("transaction_date", params.date_to);
  if (search) {
    const pattern = supabaseLikePattern(search.replaceAll(",", " "));
    const searchableColumns =
      level === "minimal"
        ? [
            "transaction_kind",
            "transaction_type",
            "description",
            "final_bucket",
            "source_sheet",
          ]
        : [
            "transaction_kind",
            "transaction_type",
            "description",
            "notes",
            "final_bucket",
            "payment_method",
            "source_sheet",
          ];
    if (level === "full")
      searchableColumns.push(
        "category",
        "counterparty_text",
        "payer_text",
        "paid_to_text",
      );
    const clauses = searchableColumns.map(
      (column) => `${column}.ilike.${pattern}`,
    );
    if (matchingPurchaseIds.length) {
      clauses.push(`related_purchase_id.in.(${matchingPurchaseIds.join(",")})`);
      if (level === "full") {
        clauses.push(
          `linked_purchase_id.in.(${matchingPurchaseIds.join(",")})`,
        );
        clauses.push(
          `and(source_type.eq.purchase,source_id.in.(${matchingPurchaseIds.join(",")}))`,
        );
      }
    }
    nextQuery = nextQuery.or(clauses.join(","));
  }
  return nextQuery;
}

async function loadFinanceTransactions({
  supabase,
  params,
  statusFilter,
  search,
  matchingPurchaseIds,
  from,
  to,
  columns,
  level,
}: {
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>;
  params: TransactionParams;
  statusFilter: string;
  search: string;
  matchingPurchaseIds: string[];
  from: number;
  to: number;
  columns: string[];
  level: "full" | "stable" | "minimal";
}) {
  const query = applyFinanceTransactionFilters({
    query: supabase
      .from(FINANCE_TRANSACTIONS_TABLE)
      .select(columns.join(", "), { count: "exact" })
      .order("transaction_date", { ascending: false }),
    params,
    statusFilter,
    search,
    matchingPurchaseIds,
    level,
  });

  return query.range(from, to);
}

export default async function FinanceTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<TransactionParams>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccess(profile)) redirect("/unauthorized");
  const canEdit = canEditFinancialTransactions({
    id: profile.id,
    role: profile.role,
    roles: profile.roles,
    canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id,
    activeStatus: profile.active_status,
  });
  const params = cleanSearchParams(await searchParams) as TransactionParams;
  const { page, pageSize, from, to } = getPagination(params);
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState
          title="Finance transactions unavailable"
          body="Supabase is not configured, so Snacky OS cannot load the money ledger."
        />
      </>
    );
  }
  const statusFilter = params.status ?? "active";
  const groupProductPurchases = params.group_product_purchases === "on";
  const search = String(params.q ?? "").trim();
  const purchaseSearchResult = search
    ? await supabase
        .from("purchase_orders")
        .select("id")
        .or(
          ["receipt_number", "order_date"]
            .map(
              (column) =>
                `${column}.ilike.${supabaseLikePattern(search.replaceAll(",", " "))}`,
            )
            .join(","),
        )
        .limit(100)
    : { data: [], error: null };
  if (purchaseSearchResult.error) {
    console.warn("[finance] Purchase lookup for transaction search failed", {
      table: "purchase_orders",
      selected_columns: ["id"],
      search,
      supabase_error: supabaseErrorDetails(purchaseSearchResult.error),
      current_user_id: profile.id ?? null,
      effective_permissions: {
        role: profile.role ?? null,
        roles: profile.roles ?? [],
        can_view_financials: canAccess(profile),
        can_edit_financial_transactions: canEdit,
      },
    });
  }
  const matchingPurchaseIds = ((purchaseSearchResult.data ?? []) as any[])
    .map((purchase) => purchase.id)
    .filter(Boolean);

  let selectedColumns = FINANCE_TRANSACTION_FULL_COLUMNS;
  let loadLevel: "full" | "stable" | "minimal" = "full";
  let ledgerWarning: string | null = null;
  let result = await loadFinanceTransactions({
    supabase,
    params,
    statusFilter,
    search,
    matchingPurchaseIds,
    from,
    to,
    columns: FINANCE_TRANSACTION_FULL_COLUMNS,
    level: "full",
  });

  if (result.error && isColumnOrSchemaError(result.error)) {
    const firstDiagnostics = await financeLedgerDiagnostics({
      supabase,
      profile,
      canEdit,
      selectedColumns,
      error: result.error,
    });
    console.error(
      "[finance] Failed to load transactions with full schema select",
      firstDiagnostics,
    );
    const missing = firstDiagnostics.missing_column;
    ledgerWarning = missing
      ? `Finance ledger loaded with core fields only because optional column "${missing}" is not available yet. Apply the latest finance migration to restore all details.`
      : "Finance ledger loaded with core fields only because optional ledger columns are not available yet. Apply the latest finance migration to restore all details.";

    const stableResult = await loadFinanceTransactions({
      supabase,
      params,
      statusFilter,
      search,
      matchingPurchaseIds,
      from,
      to,
      columns: FINANCE_TRANSACTION_STABLE_COLUMNS,
      level: "stable",
    });
    selectedColumns = FINANCE_TRANSACTION_STABLE_COLUMNS;
    loadLevel = "stable";
    result = stableResult;

    if (stableResult.error && isColumnOrSchemaError(stableResult.error)) {
      console.error(
        "[finance] Failed to load transactions with stable schema select",
        await financeLedgerDiagnostics({
          supabase,
          profile,
          canEdit,
          selectedColumns,
          error: stableResult.error,
        }),
      );
      const minimalResult = await loadFinanceTransactions({
        supabase,
        params,
        statusFilter,
        search,
        matchingPurchaseIds,
        from,
        to,
        columns: FINANCE_TRANSACTION_MINIMAL_COLUMNS,
        level: "minimal",
      });
      selectedColumns = FINANCE_TRANSACTION_MINIMAL_COLUMNS;
      loadLevel = "minimal";
      result = minimalResult;
      if (!minimalResult.error) {
        ledgerWarning =
          "Finance ledger loaded with legacy core fields only. Optional fields such as currency, account, notes, and linked source details are unavailable until the latest finance migrations are applied.";
      }
    }
  }

  if (result.error) {
    const diagnostics = await financeLedgerDiagnostics({
      supabase,
      profile,
      canEdit,
      selectedColumns,
      error: result.error,
    });
    console.error("[finance] Failed to load transactions", diagnostics);
    const details = supabaseErrorDetails(result.error);
    const permissionFailure = isPermissionError(result.error);
    if (permissionFailure) {
      return (
        <>
          <ErrorState
            title="Finance permission required"
            body={`Supabase denied SELECT on ${FINANCE_TRANSACTIONS_TABLE} for this user. Current role: ${profile.role ?? "unknown"}; roles: ${(profile.roles ?? []).join(", ") || "none"}. Admin or Finance access is required.`}
            action={
              <SecondaryButton href="/finance/transactions">
                Retry
              </SecondaryButton>
            }
          />
        </>
      );
    }
    return (
      <>
        <PageHeader
          title="Finance Transactions"
          subtitle="Money-in and money-out ledger rows from Snacky OS."
          action={
            <PrimaryButton href="/finance/transactions/new">
              Add transaction
            </PrimaryButton>
          }
        />
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No finance transactions loaded. Supabase returned{" "}
          {String(details.code ?? "an error")} while loading{" "}
          {FINANCE_TRANSACTIONS_TABLE}:{" "}
          {String(details.message ?? "Unknown database error")}. Selected
          columns: {selectedColumns.join(", ")}.
        </div>
        <EmptyState
          title="No finance transactions loaded"
          body="The ledger query failed, but this page is available while the finance schema is repaired."
        />
      </>
    );
  }
  const baseRows = ((result.data ?? []) as any[]).map(
    normalizeFinanceTransactionRow,
  );
  const count = result.count;

  const maps = {
    purchases: new Map<string, any>(),
    routes: new Map<string, any>(),
    machines: new Map<string, any>(),
    locations: new Map<string, any>(),
  };
  const [purchases, routes, machines, locations] = await Promise.all([
    fetchByIds(
      supabase,
      "purchase_orders",
      "id, receipt_number, order_date, supplier:suppliers(name)",
      baseRows.map(relatedPurchaseId).filter(Boolean),
    ),
    fetchByIds(
      supabase,
      "routes",
      "id, route_date, status",
      baseRows.map((row) => row.related_route_id).filter(Boolean),
    ),
    fetchByIds(
      supabase,
      "machines",
      "id, name, machine_code",
      baseRows.map((row) => row.related_machine_id).filter(Boolean),
    ),
    fetchByIds(
      supabase,
      "locations",
      "id, name",
      baseRows.map((row) => row.related_location_id).filter(Boolean),
    ),
  ]);
  purchases.forEach((row: any) => maps.purchases.set(row.id, row));
  routes.forEach((row: any) => maps.routes.set(row.id, row));
  machines.forEach((row: any) => maps.machines.set(row.id, row));
  locations.forEach((row: any) => maps.locations.set(row.id, row));

  const rows =
    loadLevel === "minimal" && statusFilter !== "all"
      ? baseRows.filter(
          (row) => normalizedTransactionStatus(row) === statusFilter,
        )
      : baseRows;

  const balanceRows = rows.filter(isBalanceAffectingTransaction);
  const totals = balanceRows.reduce(
    (sum, row) => {
      const currency =
        String(row.currency ?? "LYD").toUpperCase() === "USD" ? "USD" : "LYD";
      const signed = signedAmount(row);
      sum.net[currency] += signed;
      if (row.direction === "money_in") sum.in[currency] += signed;
      if (row.direction === "money_out") sum.out[currency] += Math.abs(signed);
      return sum;
    },
    {
      net: { LYD: 0, USD: 0 },
      in: { LYD: 0, USD: 0 },
      out: { LYD: 0, USD: 0 },
    },
  );
  const purchaseGroups = new Map<string, any[]>();
  const normalRows: any[] = [];

  for (const row of rows) {
    if (groupProductPurchases && isActiveProductPurchaseRow(row)) {
      const key = groupKey(row);
      purchaseGroups.set(key, [...(purchaseGroups.get(key) ?? []), row]);
    } else {
      normalRows.push(row);
    }
  }

  const displayItems = [
    ...Array.from(purchaseGroups.entries()).map(([key, groupRows]) => ({
      type: "group" as const,
      key,
      date: groupRows[0]?.transaction_date ?? "",
      rows: groupRows.sort((a, b) =>
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
      ),
    })),
    ...normalRows.map((row) => ({
      type: "row" as const,
      key: row.id,
      date: row.transaction_date,
      row,
    })),
  ].sort(
    (a, b) =>
      String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
      a.key.localeCompare(b.key),
  );

  const detailedCsvHref = csvDataHref(
    [
      "Date",
      "Direction",
      "Category",
      "Amount",
      "Currency",
      "Account",
      "Supplier",
      "Receipt",
      "Payment",
      "Status",
      "Description",
      "Notes",
      "Transaction ID",
    ],
    rows.map((row) => {
      const purchase = purchaseFor(row, maps.purchases);
      return [
        row.transaction_date,
        String(row.direction ?? "").replaceAll("_", " "),
        categoryLabel(row),
        Number(row.signed_amount ?? 0),
        row.currency ?? "LYD",
        row.transaction_effect === "transfer"
          ? `${accountLabel(row.source_account_id)} -> ${accountLabel(row.destination_account_id)}`
          : accountLabel(accountKeyFor(row)),
        purchase?.supplier?.name ?? "",
        purchase?.receipt_number ?? "",
        paymentLabel(row.payment_method),
        normalizedTransactionStatus(row),
        row.description ?? "",
        row.notes ?? "",
        row.id,
      ];
    }),
  );

  const groupedCsvHref = csvDataHref(
    [
      "Date",
      "Direction",
      "Category",
      "Amount",
      "Currency",
      "Count",
      "Payment Summary",
      "Status",
      "Description",
    ],
    displayItems.map((item) => {
      if (item.type === "group") {
        const total = item.rows.reduce(
          (sum, row) =>
            sum + Math.abs(Number(row.amount ?? row.signed_amount ?? 0)),
          0,
        );
        return [
          item.date,
          "money out",
          "Product Purchases",
          total,
          item.rows[0]?.currency ?? "LYD",
          item.rows.length,
          paymentSummary(item.rows),
          "active",
          `${item.rows.length} product purchase transactions`,
        ];
      }
      const row = item.row;
      return [
        row.transaction_date,
        String(row.direction ?? "").replaceAll("_", " "),
        categoryLabel(row),
        Number(row.signed_amount ?? 0),
        row.currency ?? "LYD",
        1,
        paymentLabel(row.payment_method),
        normalizedTransactionStatus(row),
        row.description ?? row.notes ?? "",
      ];
    }),
  );

  return (
    <>
      <PageHeader
        title="Financial Transactions"
        subtitle="Editable money in/out ledger. Only approved active rows affect balance."
        action={
          canEdit ? (
            <PrimaryButton href="/finance/transactions/new">
              Add transaction
            </PrimaryButton>
          ) : undefined
        }
      />
      {params.error ? (
        <div className="fixed right-5 top-5 z-50 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 shadow-lg">
          {params.error}
        </div>
      ) : null}
      {params.saved ? (
        <div className="fixed right-5 top-5 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg">
          Transaction saved.
        </div>
      ) : null}
      {ledgerWarning ? (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          {ledgerWarning}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">LYD net</div>
          <div
            className={`mt-1 text-3xl font-semibold ${totals.net.LYD < 0 ? "text-rose-700" : "text-slate-900"}`}
          >
            {formatFinanceMoney(totals.net.LYD, "LYD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">USD net</div>
          <div
            className={`mt-1 text-3xl font-semibold ${totals.net.USD < 0 ? "text-rose-700" : "text-slate-900"}`}
          >
            {formatFinanceMoney(totals.net.USD, "USD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Money in</div>
          <div className="mt-1 text-lg font-semibold">
            {formatFinanceMoney(totals.in.LYD, "LYD")} /{" "}
            {formatFinanceMoney(totals.in.USD, "USD")}
          </div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Money out</div>
          <div className="mt-1 text-lg font-semibold">
            {formatFinanceMoney(totals.out.LYD, "LYD")} /{" "}
            {formatFinanceMoney(totals.out.USD, "USD")}
          </div>
        </div>
      </section>

      <section className="surface-card mb-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-9">
          <input type="hidden" name="pageSize" value={pageSize} />
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search receipt, description, method..."
            className="field-input xl:col-span-2"
          />
          <select
            name="status"
            defaultValue={statusFilter}
            className="field-input"
          >
            <option value="active">Active</option>
            <option value="voided">Voided</option>
            <option value="archived">Archived</option>
            <option value="all">All statuses</option>
          </select>
          <select
            name="review"
            defaultValue={params.review ?? ""}
            className="field-input"
          >
            <option value="">All review states</option>
            <option value="needs_review">Needs review</option>
            <option value="confirmed">Confirmed</option>
            <option value="reviewed">Reviewed</option>
          </select>
          <select
            name="direction"
            defaultValue={params.direction ?? ""}
            className="field-input"
          >
            <option value="">All directions</option>
            <option value="money_in">Money in</option>
            <option value="money_out">Money out</option>
          </select>
          <select
            name="kind"
            defaultValue={params.kind ?? ""}
            className="field-input"
          >
            <option value="">All kinds</option>
            <option value="spreadsheet_import">Spreadsheet import</option>
            <option value="manual_money_in">Manual money in</option>
            <option value="manual_money_out">Manual money out</option>
            <option value="product_purchase">Product purchase</option>
            <option value="cash_collection">Cash collection</option>
          </select>
          <select
            name="group_product_purchases"
            defaultValue={groupProductPurchases ? "on" : "off"}
            className="field-input"
          >
            <option value="off">Group product purchases: Off</option>
            <option value="on">Group product purchases: On</option>
          </select>
          <input
            name="date_from"
            type="date"
            defaultValue={params.date_from ?? ""}
            className="field-input"
          />
          <input
            name="date_to"
            type="date"
            defaultValue={params.date_to ?? ""}
            className="field-input"
          />
          <div className="flex gap-2">
            <button className="btn-primary">Filter</button>
            <Link href="/finance/transactions" className="btn-secondary">
              Reset
            </Link>
          </div>
        </form>
        <div className="mt-4 flex flex-col gap-2 border-t border-slate-200 pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="text-slate-500">Export/reporting view</div>
          <div className="flex flex-wrap gap-2">
            <a
              href={groupedCsvHref}
              download="finance-transactions-grouped.csv"
              className="btn-secondary"
            >
              Export grouped CSV
            </a>
            <a
              href={detailedCsvHref}
              download="finance-transactions-detailed.csv"
              className="btn-secondary"
            >
              Export detailed CSV
            </a>
          </div>
        </div>
      </section>

      {!rows.length ? (
        <EmptyState
          title="No finance transactions found"
          body="Import historical transactions or add manual transactions to populate this ledger."
        />
      ) : (
        <>
          <DataTable
            headers={[
              "Date",
              "Direction",
              "Category",
              "Amount",
              "Description",
              "Payment",
              "Related",
              "Status",
              "Actions",
            ]}
          >
            {displayItems.map((item) => {
              if (item.type === "group") {
                const total = item.rows.reduce(
                  (sum, row) =>
                    sum +
                    Math.abs(Number(row.amount ?? row.signed_amount ?? 0)),
                  0,
                );
                const anchor = groupAnchor(item.key);
                return (
                  <Fragment key={item.key}>
                    <tr>
                      <td>{item.date}</td>
                      <td>
                        <StatusBadge status="Money Out" />
                      </td>
                      <td>
                        <div className="font-medium text-slate-900">
                          Product Purchases
                        </div>
                        <div className="text-xs text-slate-500">
                          grouped by transaction date
                        </div>
                      </td>
                      <td className="font-semibold text-rose-700">
                        {formatFinanceMoney(
                          total,
                          item.rows[0]?.currency ?? "LYD",
                        )}
                      </td>
                      <td className="max-w-md">
                        {item.rows.length} purchases / transactions
                      </td>
                      <td>{paymentSummary(item.rows)}</td>
                      <td>
                        <span className="text-slate-500">
                          {item.rows.length} linked purchases
                        </span>
                      </td>
                      <td>
                        <StatusBadge status="active" />
                      </td>
                      <td>
                        <a href={`#${anchor}`} className="btn-secondary">
                          View details
                        </a>
                      </td>
                    </tr>
                    <tr id={anchor}>
                      <td colSpan={9} className="bg-slate-50">
                        <details className="rounded-lg border border-slate-200 bg-white p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                            Expand product purchase details for {item.date}
                          </summary>
                          <div className="mt-3 overflow-x-auto">
                            <table className="min-w-full text-left text-sm">
                              <thead>
                                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                                  <th className="px-3 py-2">Supplier</th>
                                  <th className="px-3 py-2">Receipt</th>
                                  <th className="px-3 py-2">Amount</th>
                                  <th className="px-3 py-2">Payment</th>
                                  <th className="px-3 py-2">
                                    Related purchase
                                  </th>
                                  <th className="px-3 py-2">Notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {item.rows.map((row) => {
                                  const purchase = purchaseFor(
                                    row,
                                    maps.purchases,
                                  );
                                  return (
                                    <tr
                                      key={row.id}
                                      className="border-b border-slate-100 last:border-0"
                                    >
                                      <td className="px-3 py-2 font-medium text-slate-900">
                                        {purchase?.supplier?.name ?? "-"}
                                      </td>
                                      <td className="px-3 py-2">
                                        {purchase?.receipt_number ??
                                          row.description ??
                                          "-"}
                                      </td>
                                      <td className="px-3 py-2 font-semibold text-rose-700">
                                        {formatFinanceMoney(
                                          Math.abs(
                                            Number(
                                              row.amount ??
                                                row.signed_amount ??
                                                0,
                                            ),
                                          ),
                                          row.currency ?? "LYD",
                                        )}
                                      </td>
                                      <td className="px-3 py-2">
                                        {paymentLabel(row.payment_method)}
                                      </td>
                                      <td className="px-3 py-2">
                                        {purchase ? (
                                          <Link
                                            href={`/purchases/${purchase.id}`}
                                            className="link-secondary"
                                          >
                                            Purchase{" "}
                                            {purchase.receipt_number ??
                                              purchase.id.slice(0, 8)}
                                          </Link>
                                        ) : (
                                          "-"
                                        )}
                                      </td>
                                      <td className="px-3 py-2">
                                        {row.notes ?? row.description ?? "-"}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      </td>
                    </tr>
                  </Fragment>
                );
              }

              const row = item.row;
              return (
                <tr key={row.id}>
                  <td>{row.transaction_date}</td>
                  <td>
                    <StatusBadge
                      status={String(row.direction ?? "").replace("_", " ")}
                    />
                  </td>
                  <td>
                    <div className="font-medium text-slate-900">
                      {categoryLabel(row)}
                    </div>
                    <div className="text-xs text-slate-500">
                      {row.transaction_effect === "transfer"
                        ? `${accountLabel(row.source_account_id)} -> ${accountLabel(row.destination_account_id)}`
                        : accountLabel(accountKeyFor(row))}
                    </div>
                    <div className="mt-1">
                      <StatusBadge status={sourceLabel(row)} />
                    </div>
                  </td>
                  <td
                    className={`font-semibold ${Number(row.signed_amount ?? 0) < 0 ? "text-rose-700" : "text-emerald-700"}`}
                  >
                    {formatFinanceMoney(
                      Number(row.signed_amount ?? 0),
                      row.currency ?? "LYD",
                    )}
                  </td>
                  <td className="max-w-md">
                    {row.description ?? row.notes ?? "-"}
                  </td>
                  <td>{paymentLabel(row.payment_method)}</td>
                  <td>{relatedLabel(row, maps)}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={normalizedTransactionStatus(row)} />
                      {row.needs_review ? (
                        <StatusBadge status="needs_review" />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/finance/transactions/${row.id}`}
                        className="btn-secondary"
                      >
                        View
                      </Link>
                      {sourceHref(row) ? (
                        <Link
                          href={sourceHref(row) as string}
                          className="btn-secondary"
                        >
                          Open source
                        </Link>
                      ) : null}
                      {canEdit ? (
                        <Link
                          href={`/finance/transactions/${row.id}/edit`}
                          className="btn-secondary"
                        >
                          {row.needs_review ? "Review" : "Edit"}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls
            basePath="/finance/transactions"
            searchParams={params}
            page={page}
            pageSize={pageSize}
            totalCount={count ?? 0}
            itemLabel="transactions"
          />
        </>
      )}
    </>
  );
}
