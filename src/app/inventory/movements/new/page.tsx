import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isOwnerAdminRole } from "@/lib/authz";
import { createStockMovement } from "@/lib/inventory-actions";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const movementTypes = [
  { value: "storage_to_operator_bag", label: "Storage to operator bag", helper: "Take stock out of storage for a route or operator." },
  { value: "operator_bag_to_storage", label: "Operator bag to storage", helper: "Return unused operator stock back to storage." },
  { value: "storage_adjustment", label: "Storage adjustment", helper: "Record a stock count adjustment through the ledger." },
  { value: "damaged", label: "Damaged", helper: "Move damaged stock to waste." },
  { value: "expired", label: "Expired", helper: "Move expired stock to waste." },
];

function optionValue(type: string, id?: string | null) {
  return `${type}:${id ?? ""}`;
}

export default async function NewStockMovementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/inventory/movements/new")) {
    redirect("/unauthorized");
  }

  const { error } = await searchParams;
  const supabase = getSupabaseServerClient();
  const [{ data: products }, { data: storages }, { data: operators }, { data: routes }] = supabase
    ? await Promise.all([
        supabase.from("products").select("id, sku, name").eq("active", true).order("name"),
        supabase.from("storage_locations").select("id, name").eq("active", true).order("name"),
        supabase.from("team_members").select("id, full_name").eq("role", "operator").eq("active", true).order("full_name"),
        supabase.from("routes").select("id, route_date, operator_id, status").in("status", ["draft", "assigned", "in_progress"]).order("route_date", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator.full_name]));

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader
          title="New Stock Movement"
          subtitle="Create a ledger movement for route picks, returns, adjustments, damaged stock, or expired stock."
          action={<SecondaryButton href="/inventory">Back to inventory</SecondaryButton>}
        />

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
            {error}
          </div>
        ) : null}

        <form action={createStockMovement} className="space-y-6">
          <FormSection title="Movement details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Product" required>
                <select name="product_id" required className="field-input">
                  <option value="">Select product</option>
                  {products?.map((product: any) => (
                    <option key={product.id} value={product.id}>
                      {product.name}{product.sku ? ` (${product.sku})` : ""}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Quantity" required>
                <input name="quantity" type="number" min="1" step="1" required className="field-input" />
              </FormField>
              <FormField label="Reason" required>
                <select name="movement_type" required className="field-input" defaultValue="storage_to_operator_bag">
                  {movementTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Related route optional">
                <select name="related_route_id" className="field-input">
                  <option value="">No route</option>
                  {routes?.map((route: any) => (
                    <option key={route.id} value={route.id}>
                      {route.route_date} - {route.status} - {operatorById.get(route.operator_id) ?? "Unassigned"}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          </FormSection>

          <FormSection title="From and to">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="From location/type" required>
                <select name="from_location" required className="field-input">
                  <option value="">Select source</option>
                  <optgroup label="Storage">
                    {storages?.map((storage: any) => (
                      <option key={storage.id} value={optionValue("storage", storage.id)}>
                        Storage - {storage.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Operator bags">
                    {operators?.map((operator: any) => (
                      <option key={operator.id} value={optionValue("operator_bag", operator.id)}>
                        Operator bag - {operator.full_name}
                      </option>
                    ))}
                  </optgroup>
                  <option value={optionValue("adjustment")}>Adjustment account</option>
                </select>
              </FormField>
              <FormField label="To location/type" required>
                <select name="to_location" required className="field-input">
                  <option value="">Select destination</option>
                  <optgroup label="Storage">
                    {storages?.map((storage: any) => (
                      <option key={storage.id} value={optionValue("storage", storage.id)}>
                        Storage - {storage.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Operator bags">
                    {operators?.map((operator: any) => (
                      <option key={operator.id} value={optionValue("operator_bag", operator.id)}>
                        Operator bag - {operator.full_name}
                      </option>
                    ))}
                  </optgroup>
                  <option value={optionValue("waste")}>Waste</option>
                  <option value={optionValue("adjustment")}>Adjustment account</option>
                </select>
              </FormField>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {movementTypes.map((type) => (
                <div key={type.value} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2"><StatusBadge status={type.value} /></div>
                  <p className="text-sm text-slate-600">{type.helper}</p>
                </div>
              ))}
            </div>
          </FormSection>

          <FormSection title="Notes and override">
            <FormField label="Notes">
              <textarea name="notes" rows={4} className="field-input" placeholder="Reason, count reference, route handoff notes, or supervisor approval." />
            </FormField>
            {isOwnerAdminRole(profile.role) ? (
              <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <input name="admin_override" type="checkbox" className="mt-1" />
                <span>
                  <span className="block font-semibold">Owner/admin override</span>
                  Allow this movement to take more than currently available storage. Use only after a verified count decision.
                </span>
              </label>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Warehouse users cannot override available storage. Ask an owner/admin if a count correction is needed.
              </div>
            )}
          </FormSection>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button className="btn-primary">Create movement</button>
            <SecondaryButton href="/inventory">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </AppShell>
  );
}
