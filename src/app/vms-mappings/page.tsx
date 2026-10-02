import Link from "next/link";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageVmsMappings, getEffectivePermissions } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const filters = [
  { label: "All", value: "all" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Suggested", value: "suggested" },
  { label: "Needs Review", value: "needs_review" },
  { label: "Ignored", value: "ignored" },
] as const;

type SupabaseQueryError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type ProductOption = { id: string; name: string | null; sku: string | null; barcode: string | null };
type VmsProductMappingRow = {
  id: string;
  vms_product_code: string | null;
  vms_product_id: string | null;
  vms_product_name: string;
  snacky_product_id: string | null;
  product_id: string | null;
  snacky_product_name: string | null;
  status: string | null;
  match_status: string | null;
  confidence_score: number | string | null;
  vms_selling_price_lyd: number | string | null;
  vms_cost_price_lyd: number | string | null;
  latest_machine_name: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
  product: ProductOption | null;
};

const mappingSelect = [
  "id",
  "vms_product_code",
  "vms_product_id",
  "vms_product_name",
  "snacky_product_id",
  "product_id",
  "snacky_product_name",
  "confidence_score",
  "status",
  "match_status",
  "vms_selling_price_lyd",
  "vms_cost_price_lyd",
  "latest_machine_name",
  "last_seen_at",
  "updated_at",
].join(", ");

function formatDate(value: string | null | undefined) {
  if (!value) return "Not seen yet";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

function queryText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const queryError = error as SupabaseQueryError;
  return `${queryError.code ?? ""} ${queryError.message ?? ""} ${queryError.details ?? ""} ${queryError.hint ?? ""}`.toLowerCase();
}

function isMissingTableError(error: unknown, tableName = "vms_product_mappings") {
  const text = queryText(error);
  return text.includes(tableName) && (text.includes("does not exist") || text.includes("schema cache") || text.includes("could not find"));
}

function isPermissionError(error: unknown) {
  const text = queryText(error);
  return text.includes("42501") || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls");
}

function missingColumnName(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const message = String((error as SupabaseQueryError).message ?? "");
  const details = String((error as SupabaseQueryError).details ?? "");
  const combined = `${message} ${details}`;
  return combined.match(/column "?([a-zA-Z0-9_]+)"? does not exist/i)?.[1]
    ?? combined.match(/'([a-zA-Z0-9_]+)' column/i)?.[1]
    ?? combined.match(/column ([a-zA-Z0-9_]+)/i)?.[1]
    ?? null;
}

function mappingLoadErrorMessage(error: unknown, queryName: string) {
  if (isMissingTableError(error)) return "VMS product mappings could not load. Please contact admin.";
  const column = missingColumnName(error);
  if (column) return "VMS product mappings could not load. Please contact admin.";
  if (isPermissionError(error)) return "You do not have permission to load VMS product mappings.";
  if (queryName.startsWith("products.")) return "Could not load Snacky products for VMS mappings.";
  return "Snacky OS could not load VMS product mappings from Supabase.";
}

function productSearchText(product: ProductOption) {
  return [product.name, product.sku, product.barcode].filter(Boolean).join(" ").toLowerCase();
}

function normalizeMappingRow(row: VmsProductMappingRow, productById: Map<string, ProductOption>): VmsProductMappingRow {
  const snackyProductId = row.snacky_product_id ?? row.product_id ?? null;
  const status = row.status ?? row.match_status ?? "needs_review";
  return {
    ...row,
    vms_product_code: row.vms_product_code ?? row.vms_product_id ?? null,
    snacky_product_id: snackyProductId,
    product_id: row.product_id ?? snackyProductId,
    snacky_product_name: row.snacky_product_name ?? (snackyProductId ? productById.get(snackyProductId)?.name ?? null : null),
    status,
    match_status: row.match_status ?? status,
    product: snackyProductId ? productById.get(snackyProductId) ?? null : null,
  };
}

function logMappingLoadDebug(payload: {
  queryName: string;
  error?: unknown;
  currentUserId: string | null;
  effectivePermissions: string[];
  tableExists: boolean | null;
  mappingsLoaded: number | null;
  productsLoaded: number | null;
}) {
  const error = payload.error && typeof payload.error === "object" ? payload.error as SupabaseQueryError : null;
  console.info("[vms-mappings] loadVmsProductMappings", {
    queryName: payload.queryName,
    supabaseErrorCode: error?.code ?? null,
    supabaseErrorMessage: error?.message ?? null,
    currentUserId: payload.currentUserId,
    effectivePermissions: payload.effectivePermissions,
    tableExists: payload.tableExists,
    mappingsLoaded: payload.mappingsLoaded,
    productsLoaded: payload.productsLoaded,
  });
}

export default async function VmsProductMappingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord & { status?: string; q?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  const effectivePermissions = profile ? getEffectivePermissions(profile) : [];
  if (!canManageVmsMappings(profile)) {
    return (
      <>
        <PageHeader
          title="VMS Product Mapping"
          subtitle="Match product names from VMS reports to Snacky products so sales, stock, and refill recommendations work correctly."
        />
        <ErrorState title="VMS mapping access required" body="You do not have permission to load VMS product mappings." />
      </>
    );
  }

  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const status = String(params.status ?? "all");
  const q = String(params.q ?? "");
  const error = String(params.error ?? "");
  const activeStatus = filters.some((filter) => filter.value === status) ? status : "all";
  const search = q.trim();

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return <ErrorState title="VMS mappings unavailable" body="Supabase is not configured, so Snacky OS cannot load VMS product mappings." />;
  }

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, barcode, sku")
    .order("name");

  if (productsError) {
    logMappingLoadDebug({
      queryName: "products.load_for_vms_mappings",
      error: productsError,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
      tableExists: null,
      mappingsLoaded: null,
      productsLoaded: null,
    });
    return <ErrorState title="Could not load VMS mappings" body={mappingLoadErrorMessage(productsError, "products.load_for_vms_mappings")} />;
  }

  const productRows = (products ?? []) as ProductOption[];
  const productById = new Map(productRows.map((product) => [product.id, product]));
  const productIds = search
    ? productRows
      .filter((product) => productSearchText(product).includes(search.toLowerCase()))
      .slice(0, 100)
      .map((product) => product.id)
    : [];

  const countByStatus = (statusValue: string) => supabase
    .from("vms_product_mappings")
    .select("id", { count: "exact", head: true })
    .eq("status", statusValue);
  let query = supabase
    .from("vms_product_mappings")
    .select(mappingSelect, { count: "exact" })
    .order("updated_at", { ascending: false });
  if (activeStatus !== "all") query = query.eq("status", activeStatus);
  if (search) {
    const pattern = supabaseLikePattern(search.replaceAll(",", " "));
    const clauses = [`vms_product_code.ilike.${pattern}`, `vms_product_id.ilike.${pattern}`, `vms_product_name.ilike.${pattern}`, `snacky_product_name.ilike.${pattern}`];
    if (productIds.length) {
      clauses.push(`snacky_product_id.in.(${productIds.join(",")})`, `product_id.in.(${productIds.join(",")})`);
    }
    query = query.or(clauses.join(","));
  }

  const [
    totalMappingsResult,
    needsReviewResult,
    confirmedResult,
    suggestedResult,
    ignoredResult,
    mappingsResult,
  ] = await Promise.all([
    supabase.from("vms_product_mappings").select("id", { count: "exact", head: true }),
    countByStatus("needs_review"),
    countByStatus("confirmed"),
    countByStatus("suggested"),
    countByStatus("ignored"),
    query.range(from, to),
  ]);

  const loadIssues: Array<[string, unknown]> = [
    ["vms_product_mappings.total_count", totalMappingsResult.error],
    ["vms_product_mappings.needs_review_count", needsReviewResult.error],
    ["vms_product_mappings.confirmed_count", confirmedResult.error],
    ["vms_product_mappings.suggested_count", suggestedResult.error],
    ["vms_product_mappings.ignored_count", ignoredResult.error],
    ["vms_product_mappings.load_page", mappingsResult.error],
  ];
  const loadIssue = loadIssues.find(([, issue]) => Boolean(issue));

  if (loadIssue) {
    const [queryName, issue] = loadIssue;
    logMappingLoadDebug({
      queryName: "loadVmsProductMappings",
      error: issue,
      currentUserId: profile?.id ?? null,
      effectivePermissions,
      tableExists: isMissingTableError(issue) ? false : null,
      mappingsLoaded: null,
      productsLoaded: productRows.length,
    });
    return <ErrorState title="Could not load VMS mappings" body={mappingLoadErrorMessage(issue, queryName)} />;
  }

  const rows = ((mappingsResult.data ?? []) as unknown as VmsProductMappingRow[]).map((row) => normalizeMappingRow(row, productById));
  const count = mappingsResult.count ?? 0;
  const totalMappings = totalMappingsResult.count ?? 0;
  const needsReviewCount = needsReviewResult.count ?? 0;
  const confirmedCount = confirmedResult.count ?? 0;
  const suggestedCount = suggestedResult.count ?? 0;
  const ignoredCount = ignoredResult.count ?? 0;

  logMappingLoadDebug({
    queryName: "loadVmsProductMappings",
    currentUserId: profile?.id ?? null,
    effectivePermissions,
    tableExists: true,
    mappingsLoaded: rows.length,
    productsLoaded: productRows.length,
  });

  return (
    <>
      <PageHeader
        title="VMS Product Mapping"
        subtitle="Match product names from VMS reports to Snacky products so sales, stock, and refill recommendations work correctly."
      />

      <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
        Unmapped VMS products will not appear correctly in sales or refill recommendations.
      </div>

      {error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {error}
        </div>
      ) : null}

      <section className="surface-card mb-6 space-y-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <form className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <input type="hidden" name="status" value={activeStatus} />
            <input type="hidden" name="pageSize" value={pageSize} />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search VMS ID, VMS name, SKU, or Snacky product..."
              className="field-input"
            />
            <button className="btn-secondary">Search</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {filters.map((filter) => {
              const href = `/vms-mappings?status=${filter.value}${q ? `&q=${encodeURIComponent(q)}` : ""}&pageSize=${pageSize}`;
              const active = activeStatus === filter.value;
              return (
                <Link key={filter.value} href={href} className={active ? "btn-primary" : "btn-secondary"}>
                  {filter.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="confirmed" /><span className="text-lg font-semibold text-slate-900">{confirmedCount ?? 0}</span></div>
            <p className="text-sm text-slate-600">Confirmed mappings are trusted and used by imports and reprocessing.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="suggested" /><span className="text-lg font-semibold text-slate-900">{suggestedCount ?? 0}</span></div>
            <p className="text-sm text-slate-600">Suggested mappings are likely matches that still need a quick review.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="needs_review" /><span className="text-lg font-semibold text-slate-900">{needsReviewCount ?? 0}</span></div>
            <p className="text-sm text-slate-600">Needs Review entries are created from imported VMS product IDs or names that could not be matched.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="ignored" /><span className="text-lg font-semibold text-slate-900">{ignoredCount ?? 0}</span></div>
            <p className="text-sm text-slate-600">Ignored: product should not affect operations.</p>
          </div>
        </div>
      </section>

      {!totalMappings ? (
        <EmptyState title="No saved product mappings yet." body="Map products from this VMS report and Snacky OS will remember them next time." />
      ) : !(rows ?? []).length ? (
        <EmptyState title="No mappings match these filters" body="Adjust the search or status filter to view more VMS products." />
      ) : (
        <>
          <DataTable headers={["VMS Product ID", "VMS Product Name", "Snacky Product", "VMS Selling", "VMS Cost", "Latest Machine", "Match Status", "Last Seen", "Actions"]}>
            {rows.map((mapping) => (
              <tr key={mapping.id}>
                <td>{mapping.vms_product_code ?? mapping.vms_product_id ?? "-"}</td>
                <td className="font-medium text-slate-900">{mapping.vms_product_name}</td>
                <td>{mapping.product?.name ?? mapping.snacky_product_name ?? <span className="text-slate-400">Unmapped</span>}</td>
                <td>{formatMoney(mapping.vms_selling_price_lyd)}</td>
                <td>{formatMoney(mapping.vms_cost_price_lyd, 4)}</td>
                <td>{mapping.latest_machine_name ?? "-"}</td>
                <td><StatusBadge status={mapping.status ?? mapping.match_status} /></td>
                <td>{formatDate(mapping.last_seen_at)}</td>
                <td>
                  <Link className="link-secondary" href={`/vms-mappings/${mapping.id}/edit`}>
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/vms-mappings" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="mappings" />
        </>
      )}
    </>
  );
}
