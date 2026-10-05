import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  DataTable,
  FormField,
  FormPageLayout,
  FormSection,
  PageHeader,
  SecondaryButton,
  StatusBadge,
} from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const FIT_PROFILES = [
  "chocolate_bar",
  "chips_bag",
  "candy_bag",
  "pastry_biscuit",
  "nuts_bag",
  "drink_bottle_can",
  "water_bottle",
  "standard_snack",
] as const;

const LOCATION_TYPES = ["school", "university", "hospital", "mall", "office", "other"] as const;

async function smartRuleAdmin() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || profile.must_change_password || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase admin client is not configured.");
  return { profile, supabase };
}

async function saveMachineContext(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const machineId = String(formData.get("machine_id") ?? "").trim();
  const locationType = String(formData.get("location_type") ?? "").trim();
  const locationLabel = String(formData.get("location_label") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!machineId || !locationType) return;

  const { error } = await supabase.from("smart_route_machine_context").upsert({
    machine_id: machineId,
    location_type: locationType,
    location_label: locationLabel || null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "machine_id" });
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function saveProductProfile(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const productId = String(formData.get("product_id") ?? "").trim();
  const fitProfile = String(formData.get("fit_profile") ?? "").trim();
  const substitutionGroup = String(formData.get("substitution_group") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!productId || !fitProfile) return;

  const { error } = await supabase.from("smart_route_product_profiles").upsert({
    product_id: productId,
    fit_profile: fitProfile,
    substitution_group: substitutionGroup || null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "product_id" });
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function deleteProductProfile(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const productId = String(formData.get("product_id") ?? "").trim();
  if (!productId) return;
  const { error } = await supabase.from("smart_route_product_profiles").delete().eq("product_id", productId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function saveLocationRule(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const targetSpec = String(formData.get("target") ?? "").trim();
  const separator = targetSpec.indexOf(":");
  const targetType = separator > 0 ? targetSpec.slice(0, separator) : "";
  const targetValue = separator > 0 ? targetSpec.slice(separator + 1) : "";
  const productId = String(formData.get("product_id") ?? "").trim();
  const rule = String(formData.get("rule") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  const scoreRaw = Number(formData.get("score_adjustment") ?? 0);
  const scoreAdjustment = Number.isFinite(scoreRaw) ? Math.max(-100, Math.min(100, Math.trunc(scoreRaw))) : 0;
  if (!["machine", "type"].includes(targetType) || !targetValue || !productId || !["preferred", "allowed", "avoid", "prohibited"].includes(rule)) return;

  let deleteQuery = supabase.from("smart_route_location_product_rules").delete().eq("product_id", productId);
  if (targetType === "machine") deleteQuery = deleteQuery.eq("machine_id", targetValue);
  else deleteQuery = deleteQuery.eq("location_type", targetValue);
  const deleted = await deleteQuery;
  if (deleted.error) throw new Error(deleted.error.message);

  const { error } = await supabase.from("smart_route_location_product_rules").insert({
    machine_id: targetType === "machine" ? targetValue : null,
    location_id: null,
    location_type: targetType === "type" ? targetValue : null,
    product_id: productId,
    rule,
    score_adjustment: scoreAdjustment,
    notes: notes || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function deleteLocationRule(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const { error } = await supabase.from("smart_route_location_product_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function saveSlotRule(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const machineSlotId = String(formData.get("machine_slot_id") ?? "").trim();
  const productId = String(formData.get("product_id") ?? "").trim();
  const rule = String(formData.get("rule") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!machineSlotId || !productId || !["allowed", "prohibited"].includes(rule)) return;
  const capacityText = String(formData.get("verified_capacity") ?? "").trim();
  const verifiedCapacity = capacityText ? Number(capacityText) : null;
  if (rule === "allowed" && (verifiedCapacity === null || !Number.isInteger(verifiedCapacity) || verifiedCapacity < 1 || verifiedCapacity > 1000)) {
    throw new Error("Enter the physically verified capacity for this product in this lane (1–1000 units).");
  }

  const { error } = await supabase.from("smart_route_slot_product_rules").upsert({
    machine_slot_id: machineSlotId,
    product_id: productId,
    rule,
    verified_capacity: rule === "allowed" ? verifiedCapacity : null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "machine_slot_id,product_id" });
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

async function deleteSlotRule(formData: FormData) {
  "use server";
  const { supabase } = await smartRuleAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const { error } = await supabase.from("smart_route_slot_product_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/smart-routes");
}

type Product = { id: string; name: string; brand: string | null; category: string | null };
type Machine = { id: string; name: string | null; machine_code: string | null };
type Slot = { id: string; machine_id: string; slot_code: string | null; product_id: string | null };
type ProductProfile = { product_id: string; fit_profile: string | null; substitution_group: string | null; notes: string | null };
type MachineContext = { machine_id: string; location_type: string | null; location_label: string | null; notes: string | null };
type LocationRule = {
  id: string;
  machine_id: string | null;
  location_type: string | null;
  product_id: string;
  rule: string;
  score_adjustment: number | null;
  notes: string | null;
};
type SlotRule = {
  id: string;
  machine_slot_id: string;
  product_id: string;
  rule: string;
  verified_capacity: number | null;
  notes: string | null;
};

export default async function SmartRouteRulesPage() {
  const { supabase } = await smartRuleAdmin();

  const [
    productsResult,
    machinesResult,
    slotsResult,
    profilesResult,
    contextsResult,
    locationRulesResult,
    slotRulesResult,
  ] = await Promise.all([
    supabase.from("products").select("id, name, brand, category").eq("active", true).order("name"),
    supabase.from("machines").select("id, name, machine_code").eq("status", "active").order("name"),
    supabase.from("machine_slots").select("id, machine_id, slot_code, product_id").eq("active", true).order("slot_code"),
    supabase.from("smart_route_product_profiles").select("product_id, fit_profile, substitution_group, notes").order("updated_at", { ascending: false }),
    supabase.from("smart_route_machine_context").select("machine_id, location_type, location_label, notes").order("location_type"),
    supabase.from("smart_route_location_product_rules").select("id, machine_id, location_type, product_id, rule, score_adjustment, notes").order("created_at", { ascending: false }),
    supabase.from("smart_route_slot_product_rules").select("id, machine_slot_id, product_id, rule, verified_capacity, notes").order("created_at", { ascending: false }),
  ]);

  const firstError = [
    productsResult.error,
    machinesResult.error,
    slotsResult.error,
    profilesResult.error,
    contextsResult.error,
    locationRulesResult.error,
    slotRulesResult.error,
  ].find(Boolean);
  if (firstError) throw new Error(firstError.message);

  const products = (productsResult.data ?? []) as Product[];
  const machines = (machinesResult.data ?? []) as Machine[];
  const slots = (slotsResult.data ?? []) as Slot[];
  const profiles = (profilesResult.data ?? []) as ProductProfile[];
  const contexts = (contextsResult.data ?? []) as MachineContext[];
  const locationRules = (locationRulesResult.data ?? []) as LocationRule[];
  const slotRules = (slotRulesResult.data ?? []) as SlotRule[];

  const productById = new Map(products.map((row) => [row.id, row]));
  const machineById = new Map(machines.map((row) => [row.id, row]));
  const slotById = new Map(slots.map((row) => [row.id, row]));
  const contextByMachine = new Map(contexts.map((row) => [row.machine_id, row]));

  return (
    <FormPageLayout>
      <PageHeader
        title="Smart route rules"
        subtitle="Hard business rules for AI route planning. These rules filter and rank candidates before the AI can make a suggestion."
        action={<SecondaryButton href="/routes/new">Back to route builder</SecondaryButton>}
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Smart route rules" }]}
      />

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
        <div className="font-semibold">AI never overrides these rules</div>
        <p className="mt-1 leading-6">
          Prohibited products are removed before the AI sees candidates. Products with no unreserved storage are also removed. Nonempty lane replacements must explicitly remove and track the old stock first; never mix products.
        </p>
      </div>

      <FormSection
        title="Machine venue context"
        description="Tell Snacky what kind of place each machine serves. This lets demand from schools, universities, hospitals and malls influence recommendations without changing core machine/location records."
      >
        <form action={saveMachineContext} className="grid gap-4 md:grid-cols-2">
          <FormField label="Machine" required>
            <select name="machine_id" className="field-input" required>
              <option value="">Select machine</option>
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name || machine.machine_code || machine.id}
                  {contextByMachine.get(machine.id)?.location_type ? " · " + contextByMachine.get(machine.id)?.location_type : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Venue type" required>
            <select name="location_type" className="field-input" required>
              {LOCATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </FormField>
          <FormField label="Display label">
            <input name="location_label" className="field-input" placeholder="e.g. Elite Future School" />
          </FormField>
          <FormField label="Notes">
            <input name="notes" className="field-input" placeholder="Optional planning note" />
          </FormField>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary">Save machine context</button>
          </div>
        </form>

        <div className="table-wrap">
          <DataTable headers={["Machine", "Venue type", "Planning label", "Notes"]}>
            {contexts.map((context) => (
              <tr key={context.machine_id}>
                <td>{machineById.get(context.machine_id)?.name ?? context.machine_id}</td>
                <td><StatusBadge status={context.location_type} /></td>
                <td>{context.location_label || "—"}</td>
                <td>{context.notes || "—"}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      </FormSection>

      <FormSection
        title="Product fit / substitution family"
        description="Fit profile describes physical packaging shape. Substitution family can make replacement tighter than shape alone, for example chocolate-small-bar or 330ml-can."
      >
        <form action={saveProductProfile} className="grid gap-4 md:grid-cols-2">
          <FormField label="Product" required>
            <select name="product_id" className="field-input" required>
              <option value="">Select product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </FormField>
          <FormField label="Physical fit profile" required>
            <select name="fit_profile" className="field-input" required>
              {FIT_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
            </select>
          </FormField>
          <FormField label="Substitution family">
            <input name="substitution_group" className="field-input" placeholder="e.g. chocolate-small-bar" />
          </FormField>
          <FormField label="Notes">
            <input name="notes" className="field-input" placeholder="Optional" />
          </FormField>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary">Save product profile</button>
          </div>
        </form>

        {profiles.length ? (
          <div className="table-wrap">
            <DataTable headers={["Product", "Fit", "Substitution family", "Notes", ""]}>
              {profiles.map((profile) => (
                <tr key={profile.product_id}>
                  <td>{productById.get(profile.product_id)?.name ?? profile.product_id}</td>
                  <td><StatusBadge status={profile.fit_profile} /></td>
                  <td>{profile.substitution_group || "—"}</td>
                  <td>{profile.notes || "—"}</td>
                  <td>
                    <form action={deleteProductProfile}>
                      <input type="hidden" name="product_id" value={profile.product_id} />
                      <button type="submit" className="link-secondary text-xs">Remove override</button>
                    </form>
                  </td>
                </tr>
              ))}
            </DataTable>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No manual fit overrides yet. Snacky will infer broad fit from the product catalog and exact-slot history.</p>
        )}
      </FormSection>

      <FormSection
        title="Machine / venue product rules"
        description="Use Prohibited for a hard block. Preferred boosts a product at that exact machine or venue type. Avoid lowers it without completely blocking it."
      >
        <form action={saveLocationRule} className="grid gap-4 md:grid-cols-2">
          <FormField label="Target" required hint="Choose a venue type for a broad rule, or one exact machine for a local exception.">
            <select name="target" className="field-input" required>
              <optgroup label="Venue types">
                {LOCATION_TYPES.map((type) => <option key={"type:" + type} value={"type:" + type}>{type}</option>)}
              </optgroup>
              <optgroup label="Exact machines">
                {machines.map((machine) => <option key={"machine:" + machine.id} value={"machine:" + machine.id}>{machine.name || machine.machine_code || machine.id}</option>)}
              </optgroup>
            </select>
          </FormField>
          <FormField label="Product" required>
            <select name="product_id" className="field-input" required>
              <option value="">Select product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </FormField>
          <FormField label="Rule" required>
            <select name="rule" className="field-input" required>
              <option value="preferred">Preferred</option>
              <option value="allowed">Allowed</option>
              <option value="avoid">Avoid</option>
              <option value="prohibited">Prohibited</option>
            </select>
          </FormField>
          <FormField label="Score adjustment" hint="Optional fine tuning from -100 to +100. Prohibited ignores the score.">
            <input name="score_adjustment" type="number" min={-100} max={100} defaultValue={0} className="field-input" />
          </FormField>
          <FormField label="Notes">
            <input name="notes" className="field-input" placeholder="Why this rule exists" />
          </FormField>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary">Save product rule</button>
          </div>
        </form>

        {locationRules.length ? (
          <div className="table-wrap">
            <DataTable headers={["Scope", "Product", "Rule", "Score", "Notes", ""]}>
              {locationRules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.machine_id ? (machineById.get(rule.machine_id)?.name ?? rule.machine_id) : rule.location_type}</td>
                  <td>{productById.get(rule.product_id)?.name ?? rule.product_id}</td>
                  <td><StatusBadge status={rule.rule} /></td>
                  <td>{rule.score_adjustment ?? 0}</td>
                  <td>{rule.notes || "—"}</td>
                  <td>
                    <form action={deleteLocationRule}>
                      <input type="hidden" name="id" value={rule.id} />
                      <button type="submit" className="link-secondary text-xs">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </DataTable>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No machine or venue product rules yet.</p>
        )}
      </FormSection>

      <FormSection
        title="Exact lane compatibility"
        description="Approve only physically tested product/lane combinations and enter the verified capacity. Product plans do not infer packaging fit from a category or product name. Prohibited always blocks it."
      >
        <form action={saveSlotRule} className="grid gap-4 md:grid-cols-2">
          <FormField label="Machine lane" required>
            <select name="machine_slot_id" className="field-input" required>
              <option value="">Select lane</option>
              {slots.map((slot) => {
                const machine = machineById.get(slot.machine_id);
                const current = slot.product_id ? productById.get(slot.product_id)?.name : null;
                const label = (machine?.name || machine?.machine_code || slot.machine_id)
                  + " · lane " + (slot.slot_code || "?")
                  + (current ? " · now " + current : "");
                return <option key={slot.id} value={slot.id}>{label}</option>;
              })}
            </select>
          </FormField>
          <FormField label="Product" required>
            <select name="product_id" className="field-input" required>
              <option value="">Select product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </FormField>
          <FormField label="Compatibility rule" required>
            <select name="rule" className="field-input" required>
              <option value="allowed">Allowed in this lane</option>
              <option value="prohibited">Prohibited in this lane</option>
            </select>
          </FormField>
          <FormField label="Verified capacity for this product" hint="Required for Allowed. Count the units that physically fit after a safe vend test; do not copy another product’s capacity.">
            <input name="verified_capacity" type="number" min={1} max={1000} step={1} className="field-input" placeholder="e.g. 12" />
          </FormField>
          <FormField label="Notes">
            <input name="notes" className="field-input" placeholder="e.g. package too wide" />
          </FormField>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary">Save lane rule</button>
          </div>
        </form>

        {slotRules.length ? (
          <div className="table-wrap">
            <DataTable headers={["Lane", "Product", "Rule", "Verified capacity", "Notes", ""]}>
              {slotRules.map((rule) => {
                const slot = slotById.get(rule.machine_slot_id);
                const machine = slot ? machineById.get(slot.machine_id) : null;
                return (
                  <tr key={rule.id}>
                    <td>{machine?.name ?? "Unknown machine"} · {slot?.slot_code ?? "?"}</td>
                    <td>{productById.get(rule.product_id)?.name ?? rule.product_id}</td>
                    <td><StatusBadge status={rule.rule} /></td>
                    <td>{rule.verified_capacity ?? "Not verified"}</td>
                    <td>{rule.notes || "—"}</td>
                    <td>
                      <form action={deleteSlotRule}>
                        <input type="hidden" name="id" value={rule.id} />
                        <button type="submit" className="link-secondary text-xs">Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No exact lane exceptions yet. Exact-slot XY history is still used as positive fit evidence.</p>
        )}
      </FormSection>
    </FormPageLayout>
  );
}
