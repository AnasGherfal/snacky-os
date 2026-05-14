import { AppShell } from "@/components/AppShell";
import { FormPageLayout, PageHeader } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";

export const dynamic = "force-dynamic";

export default async function NewRoutePage() {
  const supabase = getSupabaseServerClient();
  const [{ data: operators }, { data: machines }, { data: recommendations }, { data: storageInventory }] = supabase
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
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Create route" subtitle="Build a refill route from machine stops and refill recommendations." />
        <RouteCreateForm
          operators={operators ?? []}
          machines={machines ?? []}
          recommendations={recommendations ?? []}
          storageInventory={storageInventory ?? []}
          defaultRouteDate={today}
        />
      </FormPageLayout>
    </AppShell>
  );
}
