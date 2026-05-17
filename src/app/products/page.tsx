import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SearchInput, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; imageUpload?: string }> }) {
  const { q = "", imageUpload = "" } = await searchParams;
  const s = getSupabaseServerClient();
  const query = s?.from("products").select("id,sku,name,category,selling_price,current_selling_price_lyd,vms_selling_price_lyd,selling_price_source,current_cost_price_lyd,last_purchase_cost_lyd,average_cost_lyd,cost_price_source,active,image_url,suppliers(name)").order("name");
  const { data } = query ? (q ? await query.ilike("name", `%${q}%`) : await query) : { data: [] };

  return (
    <AppShell>
      <PageHeader title="Products" subtitle="Product catalog used in VMS mapping, slot planning, and inventory ledger." action={<PrimaryButton href="/products/new">Add product</PrimaryButton>} />
      {imageUpload === "storage-unavailable" ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Image upload is unavailable locally. You can paste an image URL instead.
        </div>
      ) : null}
      <form className="mb-4"><SearchInput placeholder="Search by product name..." /></form>
      {!data?.length ? <EmptyState title="No products yet" body="Create products to map VMS items and build machine slot plans." /> :
        <DataTable headers={["Image", "SKU", "Product", "Category", "Supplier", "Current Selling", "VMS Selling", "Last Purchase Cost", "Average Cost", "Selling Source", "Cost Source", "Status", "Actions"]}>
          {data.map((product: any) => (
            <tr key={product.id}>
              <td><ProductThumbnail imageUrl={product.image_url} name={product.name} /></td>
              <td>{product.sku}</td>
              <td className="font-medium">{product.name}</td>
              <td>{product.category}</td>
              <td>{product.suppliers?.name ?? "-"}</td>
              <td>{formatMoney(product.current_selling_price_lyd ?? product.selling_price)}</td>
              <td>{formatMoney(product.vms_selling_price_lyd)}</td>
              <td>{formatMoney(product.last_purchase_cost_lyd, 4)}</td>
              <td>{formatMoney(product.average_cost_lyd, 4)}</td>
              <td><StatusBadge status={String(product.selling_price_source ?? "initial_import").replaceAll("_", " ")} /></td>
              <td><StatusBadge status={String(product.cost_price_source ?? "initial_import").replaceAll("_", " ")} /></td>
              <td><StatusBadge status={product.active ? "active" : "inactive"} /></td>
              <td><div className="flex flex-wrap gap-2"><Link href={`/products/${product.id}/edit`} className="btn-secondary">Edit</Link><Link href={`/products/${product.id}/history`} className="btn-secondary">History</Link></div></td>
            </tr>
          ))}
        </DataTable>}
    </AppShell>
  );
}
