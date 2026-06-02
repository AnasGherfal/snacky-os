import Link from "next/link";
import { redirect } from "next/navigation";
import { PaginationControls } from "@/components/PaginationControls";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { ProductSourceBadge } from "@/components/ProductSourceBadge";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canAddProducts, canViewFinancials, hasPermission } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord, supabaseLikePattern } from "@/lib/pagination";

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

function supabaseErrorPayload(error: any) {
  return {
    code: error?.code ?? null,
    message: error?.message ?? String(error ?? "Unknown Supabase error"),
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  };
}

function supabaseErrorText(error: any) {
  const payload = supabaseErrorPayload(error);
  return [payload.code, payload.message, payload.details, payload.hint].filter(Boolean).join(" - ");
}

function isPermissionError(error: any) {
  const text = supabaseErrorText(error).toLowerCase();
  return String(error?.code ?? "") === "42501" || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls");
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsRecord & { q?: string; imageUpload?: string; debug?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/products")}`);
  const userContext = { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status };
  if (!canAccessPath(userContext, "/products")) {
    return (
      <>
        <ErrorState
          title="Products permission required"
          body="Your account cannot view the product catalog. Ask an admin to add Warehouse, Purchasing, Supervisor, Finance, or Admin access."
          action={<SecondaryButton href="/dashboard">Back to dashboard</SecondaryButton>}
        />
      </>
    );
  }
  const canCreateProduct = canAddProducts(profile);
  const canEditProducts = hasPermission(profile, "products.edit");
  const canSeeCost = canViewFinancials(userContext);
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const q = String(params.q ?? "");
  const imageUpload = String(params.imageUpload ?? "");
  const showDebug = hasPermission(profile, "system.settings");
  const s = await getAuthenticatedSupabaseServerClient();
  if (!s) {
    return (
      <>
        <ErrorState title="Products unavailable" body="Supabase is not configured, so Snacky OS cannot load the product catalog." />
      </>
    );
  }
  const productSelect = [
    "id",
    "sku",
    "barcode",
    "name",
    "category",
    "brand",
    "case_quantity",
    "import_source",
    "last_vms_seen_at",
    "selling_price",
    "current_selling_price_lyd",
    "vms_selling_price_lyd",
    "selling_price_source",
    "active",
    "image_url",
    "supplier:suppliers!products_supplier_id_fkey(name)",
    ...(canSeeCost ? ["current_cost_price_lyd", "last_purchase_cost_lyd", "average_cost_lyd", "last_purchase_date", "last_supplier_id", "last_supplier:suppliers!products_last_supplier_id_fkey(name)", "cost_price_source"] : []),
  ].join(",");
  let query = s.from("products").select(productSelect, { count: "exact" }).order("name");
  const search = q.trim();
  if (search) {
    const pattern = supabaseLikePattern(search.replaceAll(",", " "));
    query = query.or(["sku", "barcode", "name", "category", "brand"].map((column) => `${column}.ilike.${pattern}`).join(","));
  }
  const { data, count, error: productsError } = await query.range(from, to);
  if (productsError) {
    const payload = supabaseErrorPayload(productsError);
    console.error("[products] Failed to load products", {
      table_or_view: "products",
      select: productSelect,
      order: "name",
      range: { from, to },
      search,
      current_user_id: profile.id,
      user_roles: profile.roles,
      supabase_error: payload,
    });
    const debugMessage = `Supabase products query failed: ${supabaseErrorText(productsError)}`;
    return (
      <>
        <ErrorState
          title={isPermissionError(productsError) ? "Products permission required" : "Could not load products"}
          body={
            showDebug
              ? debugMessage
              : isPermissionError(productsError)
                ? "Supabase blocked product access for this role. Ask an admin to check product SELECT/RLS permissions."
                : "Snacky OS could not load products. Admin debug logs include the exact Supabase query error."
          }
          action={<SecondaryButton href="/products">Retry</SecondaryButton>}
        />
      </>
    );
  }
  const imageUploadMessage =
    imageUpload === "storage-unavailable"
      ? "Storage is not configured in this environment. Use image URL for now."
      : imageUpload === "invalid-file"
        ? "Image upload must be a PNG, JPG, or WEBP file that is 5MB or smaller. Use image URL for now."
        : "";

  return (
    <>
      <PageHeader title="Products" subtitle="Product catalog used in VMS mapping, slot planning, and inventory ledger." action={canCreateProduct ? <PrimaryButton href="/products/new">Add product</PrimaryButton> : null} />
      {imageUploadMessage ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {imageUploadMessage}
        </div>
      ) : null}
      <form className="mb-4 flex flex-wrap gap-2">
        <input type="hidden" name="pageSize" value={pageSize} />
        <SearchInput defaultValue={q} placeholder="Search by SKU, VMS code, barcode, or product name..." />
        <button className="btn-secondary" type="submit">Search</button>
      </form>
      {!data?.length ? <EmptyState title="No products yet" body="Create products to map VMS items and build machine slot plans." /> :
        <>
          <div className="mb-3 text-sm text-slate-500">
            Showing products{search ? ` matching "${q}"` : ""}.
          </div>
          <DataTable headers={["Image", "SKU", "Product", "Category", "Case Qty", "Supplier", "Product Source", "Current Selling", "VMS Selling", ...(canSeeCost ? ["Last Purchase Cost", "Last Purchase Date", "Last Supplier", "Average Cost"] : []), "Selling Source", ...(canSeeCost ? ["Cost Source"] : []), "Status", "Actions"]}>
            {data.map((product: any) => (
              <tr key={product.id}>
                <td><ProductThumbnail imageUrl={product.image_url} name={product.name} /></td>
                <td>{product.sku}</td>
                <td className="font-medium">{product.name}</td>
                <td>{product.category}</td>
                <td>{product.case_quantity ?? 1}</td>
                <td>{product.supplier?.name ?? "-"}</td>
                <td><ProductSourceBadge source={product.import_source} /></td>
                <td>{formatMoney(product.current_selling_price_lyd ?? product.selling_price)}</td>
                <td>{formatMoney(product.vms_selling_price_lyd)}</td>
                {canSeeCost ? <td>{formatMoney(product.last_purchase_cost_lyd, 4)}</td> : null}
                {canSeeCost ? <td>{product.last_purchase_date ?? "-"}</td> : null}
                {canSeeCost ? <td>{product.last_supplier?.name ?? "-"}</td> : null}
                {canSeeCost ? <td>{formatMoney(product.average_cost_lyd, 4)}</td> : null}
                <td><ProductSourceBadge source={product.selling_price_source} /></td>
                {canSeeCost ? <td><ProductSourceBadge source={product.cost_price_source} /></td> : null}
                <td><StatusBadge status={product.active ? "active" : "inactive"} /></td>
                <td><div className="flex flex-wrap gap-2">{canEditProducts ? <Link href={`/products/${product.id}/edit`} className="btn-secondary">Edit</Link> : null}<Link href={`/products/${product.id}/history`} className="btn-secondary">History</Link></div></td>
              </tr>
            ))}
          </DataTable>
          <PaginationControls basePath="/products" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="products" />
        </>}
    </>
  );
}
