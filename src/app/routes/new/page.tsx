import { AppShell } from "@/components/AppShell";
import { FormPageLayout, PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewRoutePage() {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/routes/new")) {
    redirect("/unauthorized");
  }

  const supabase = getSupabaseServerClient();
  const [{ data: operators }, { data: machines }, { data: recommendations }, { data: storageInventory }, { data: reservedStock }] = supabase
    ? await Promise.all([
        supabase.from("team_members").select("id, full_name").eq("role", "operator").eq("active", true).order("full_name"),
        supabase.from("machines").select("id, name, machine_code").eq("status", "active").order("name"),
        supabase
          .from("refill_recommendations")
          .select("machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_id, product_name, current_qty, par_qty, suggested_qty, available_storage_qty, final_qty_to_take")
          .order("machine_name"),
        supabase
          .from("current_inventory_by_location")
          .select("product_id, product_name, quantity_on_hand")
          .eq("location_type", "storage")
          .gt("quantity_on_hand", 0)
          .order("product_name"),
        supabase
          .from("route_stock_lines")
          .select("product_id, planned_qty, picked_qty, routes!inner(status)")
          .in("routes.status", ["draft", "assigned"]),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const today = new Date().toISOString().slice(0, 10);
  const storageByProduct = new Map<string, { product_id: string; product_name: string; quantity_on_hand: number }>();
  (storageInventory ?? []).forEach((row: any) => {
    const current = storageByProduct.get(row.product_id);
    storageByProduct.set(row.product_id, {
      product_id: row.product_id,
      product_name: row.product_name,
      quantity_on_hand: (current?.quantity_on_hand ?? 0) + Number(row.quantity_on_hand ?? 0),
    });
  });
  const reservedByProduct = new Map<string, number>();
  (reservedStock ?? []).forEach((row: any) => {
    const reserved = Math.max(0, Number(row.planned_qty ?? 0) - Number(row.picked_qty ?? 0));
    reservedByProduct.set(row.product_id, (reservedByProduct.get(row.product_id) ?? 0) + reserved);
  });
  const availableStorage = Array.from(storageByProduct.values())
    .map((row) => ({ ...row, quantity_on_hand: Math.max(0, row.quantity_on_hand - (reservedByProduct.get(row.product_id) ?? 0)) }))
    .filter((row) => row.quantity_on_hand > 0);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Create route" subtitle="Build a refill route from machine stops and refill recommendations." />
        <RouteCreateForm
          operators={operators ?? []}
          machines={machines ?? []}
          recommendations={recommendations ?? []}
          storageInventory={availableStorage}
          defaultRouteDate={today}
        />
      </FormPageLayout>
    </AppShell>
  );
}
