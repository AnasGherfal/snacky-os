import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, PrimaryButton, SearchInput, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const s = getSupabaseServerClient();
  const query = s?.from("products").select("id,sku,name,category,selling_price,active,suppliers(name)").order("name");
  const { data } = query ? (q ? await query.ilike("name", `%${q}%`) : await query) : { data: [] };

  return <AppShell><PageHeader title="Products" subtitle="Product catalog used in VMS mapping, slot planning, and inventory ledger." action={<PrimaryButton href="/products/new">Add product</PrimaryButton>} />
    <form className="mb-4"><SearchInput placeholder="Search by product name..." /></form>
    {!data?.length ? <EmptyState title="No products yet" body="Create products to map VMS items and build machine slot plans."/> :
    <DataTable headers={["SKU","Product","Category","Supplier","Selling LYD","Status","Actions"]}>{data.map((p:any)=><tr key={p.id}><td>{p.sku}</td><td className="font-medium">{p.name}</td><td>{p.category}</td><td>{p.suppliers?.name??"-"}</td><td>{Number(p.selling_price||0).toFixed(2)}</td><td><StatusBadge status={p.active?"active":"inactive"}/></td><td><Link href={`/products/${p.id}/edit`} className="btn-secondary">Edit</Link></td></tr>)}</DataTable>}
  </AppShell>;
}
