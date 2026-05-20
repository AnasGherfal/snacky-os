import Link from "next/link";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function SuppliersPage() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title="Suppliers unavailable" body="Supabase is not configured, so Snacky OS cannot load supplier records." />
      </>
    );
  }

  const { data, error } = await supabase.from("suppliers").select("id,name,contact_name,phone").order("name");
  if (error) {
    console.error("[suppliers] Failed to load suppliers", error);
    return (
      <>
        <ErrorState title="Could not load suppliers" body="Snacky OS could not load supplier records from Supabase." action={<SecondaryButton href="/suppliers">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Supplier master data used by purchases, product costs, and receiving history."
        breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Suppliers" }]}
        action={<PrimaryButton href="/suppliers/new">Add supplier</PrimaryButton>}
      />
      {!data?.length ? (
        <EmptyState title="No suppliers yet" body="Add suppliers before recording purchases and receipt history." action={<PrimaryButton href="/suppliers/new">Add supplier</PrimaryButton>} />
      ) : (
        <DataTable headers={["Name", "Contact", "Phone", "Actions"]}>
          {data.map((supplier: any) => (
            <tr key={supplier.id}>
              <td className="font-medium text-slate-900">{supplier.name}</td>
              <td>{supplier.contact_name || "-"}</td>
              <td>{supplier.phone || "-"}</td>
              <td><Link href={`/suppliers/${supplier.id}`} className="btn-secondary">Edit</Link></td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
