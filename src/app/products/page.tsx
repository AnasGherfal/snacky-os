import Link from "next/link";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { ProductSourceBadge } from "@/components/ProductSourceBadge";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SearchInput, SecondaryButton, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; imageUpload?: string }> }) {
  await requireCurrentProfileForPath("/products");
  const { q = "", imageUpload = "" } = await searchParams;
  const s = getSupabaseServerClient();
  if (!s) {
    return (
      <>
        <ErrorState title="Products unavailable" body="Supabase is not configured, so Snacky OS cannot load the product catalog." />
      </>
    );
  }
  const query = s?.from("products").select("id,sku,barcode,name,category,brand,import_source,last_vms_seen_at,selling_price,current_selling_price_lyd,vms_selling_price_lyd,selling_price_source,current_cost_price_lyd,last_purchase_cost_lyd,average_cost_lyd,cost_price_source,active,image_url,suppliers(name)").order("name");
  const { data: productRows, error: productsError } = query ? await query : { data: [], error: null };
  if (productsError) {
    console.error("[products] Failed to load products", productsError);
    return (
      <>
        <ErrorState title="Could not load products" body="Snacky OS could not load real products from Supabase." action={<SecondaryButton href="/products">Retry</SecondaryButton>} />
      </>
    );
  }
  const search = q.trim().toLowerCase();
  const data = search
    ? (productRows ?? []).filter((product: any) =>
        [product.sku, product.barcode, product.name, product.category, product.brand]
          .some((value) => String(value ?? "").toLowerCase().includes(search)),
      )
    : productRows;
  const imageUploadMessage =
    imageUpload === "storage-unavailable"
      ? "Storage is not configured in this environment. Use image URL for now."
      : imageUpload === "invalid-file"
        ? "Image upload must be a PNG, JPG, or WEBP file that is 5MB or smaller. Use image URL for now."
        : "";

  return (
    <>
      <PageHeader title="Products" subtitle="Product catalog used in VMS mapping, slot planning, and inventory ledger." action={<PrimaryButton href="/products/new">Add product</PrimaryButton>} />
      {imageUploadMessage ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {imageUploadMessage}
        </div>
      ) : null}
      <form className="mb-4"><SearchInput placeholder="Search by SKU, VMS code, barcode, or product name..." /></form>
      {!data?.length ? <EmptyState title="No products yet" body="Create products to map VMS items and build machine slot plans." /> :
        <>
          <div className="mb-3 text-sm text-slate-500">
            Showing {data.length} product{data.length === 1 ? "" : "s"}{search ? ` matching "${q}"` : ""}.
          </div>
          <DataTable headers={["Image", "SKU", "Product", "Category", "Supplier", "Product Source", "Current Selling", "VMS Selling", "Last Purchase Cost", "Average Cost", "Selling Source", "Cost Source", "Status", "Actions"]}>
            {data.map((product: any) => (
              <tr key={product.id}>
                <td><ProductThumbnail imageUrl={product.image_url} name={product.name} /></td>
                <td>{product.sku}</td>
                <td className="font-medium">{product.name}</td>
                <td>{product.category}</td>
                <td>{product.suppliers?.name ?? "-"}</td>
                <td><ProductSourceBadge source={product.import_source} /></td>
                <td>{formatMoney(product.current_selling_price_lyd ?? product.selling_price)}</td>
                <td>{formatMoney(product.vms_selling_price_lyd)}</td>
                <td>{formatMoney(product.last_purchase_cost_lyd, 4)}</td>
                <td>{formatMoney(product.average_cost_lyd, 4)}</td>
                <td><ProductSourceBadge source={product.selling_price_source} /></td>
                <td><ProductSourceBadge source={product.cost_price_source} /></td>
                <td><StatusBadge status={product.active ? "active" : "inactive"} /></td>
                <td><div className="flex flex-wrap gap-2"><Link href={`/products/${product.id}/edit`} className="btn-secondary">Edit</Link><Link href={`/products/${product.id}/history`} className="btn-secondary">History</Link></div></td>
              </tr>
            ))}
          </DataTable>
        </>}
    </>
  );
}
