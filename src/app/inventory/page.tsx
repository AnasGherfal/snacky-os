import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function InventoryPage() {
  const supabase = getSupabaseServerClient();
  const { data: inventory } = supabase
    ? await supabase.from("current_inventory_by_location").select("product_name, location_type, location_name, quantity_on_hand").order("product_name")
    : { data: null };

  return <AppShell><PageHeader title="Storage Inventory" subtitle="Ledger-calculated inventory positions across storage, operators, and machines." />{!inventory?.length ? <EmptyState title="No inventory movement yet" body="Receive purchases and execute refills to populate inventory balances." /> : <DataTable headers={["Product","Location Type","Location","Qty"]}>{inventory.map((row:any,idx:number)=><tr key={`${row.product_name}-${idx}`}><td className="font-medium">{row.product_name}</td><td><StatusBadge status={row.location_type} /></td><td>{row.location_name}</td><td>{row.quantity_on_hand}</td></tr>)}</DataTable>}</AppShell>;
}
