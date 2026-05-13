import { AppShell } from "@/components/AppShell";
import { FormPageLayout, PageHeader } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { RouteCreateForm } from "@/app/routes/new/RouteCreateForm";

export const dynamic = "force-dynamic";

export default async function NewRoutePage() {
  const supabase = getSupabaseServerClient();
  const [{ data: operators }, { data: machines }, { data: recommendations }] = supabase
    ? await Promise.all([
        supabase.from("team_members").select("id, full_name").eq("role", "operator").eq("active", true).order("full_name"),
        supabase.from("machines").select("id, name, machine_code").eq("status", "active").order("name"),
        supabase
          .from("refill_recommendations")
          .select("machine_slot_id, machine_id, machine_name, machine_code, slot_code, product_name, current_qty, par_qty, suggested_qty, available_storage_qty")
          .order("machine_name"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const today = new Date().toISOString().slice(0, 10);

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Create route" subtitle="Build a refill route from machine stops and refill recommendations." />
        <RouteCreateForm
          operators={operators ?? []}
          machines={machines ?? []}
          recommendations={recommendations ?? []}
          defaultRouteDate={today}
        />
      </FormPageLayout>
    </AppShell>
  );
}
