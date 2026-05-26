import { notFound } from "next/navigation";
import { LocalDraftForm } from "@/components/LocalDraft";
import { ErrorState, FormField, FormPageLayout, FormSection, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageVmsMappings } from "@/lib/authz";
import { updateVmsProductMapping } from "@/lib/vms-mapping-actions";

export const dynamic = "force-dynamic";

const statusOptions = [
  { value: "confirmed", label: "Confirmed", helper: "Mapping is trusted and used by imports." },
  { value: "suggested", label: "Suggested", helper: "Likely match that should be reviewed before confirmation." },
  { value: "needs_review", label: "Needs Review", helper: "Imported product needs manual matching." },
  { value: "ignored", label: "Ignored", helper: "Product should not affect operations." },
];

type ProductOption = { id: string; name: string; sku: string | null };
type VmsProductMapping = {
  id: string;
  vms_product_code: string | null;
  vms_product_id: string | null;
  vms_product_name: string;
  snacky_product_id: string | null;
  product_id: string | null;
  snacky_product_name: string | null;
  status: string | null;
  match_status: string | null;
  vms_selling_price_lyd: number | string | null;
  vms_cost_price_lyd: number | string | null;
  latest_vms_machine_id: string | null;
  latest_machine_name: string | null;
  last_seen_at: string | null;
};

const mappingSelect = [
  "id",
  "vms_product_code",
  "vms_product_id",
  "vms_product_name",
  "snacky_product_id",
  "product_id",
  "snacky_product_name",
  "status",
  "match_status",
  "vms_selling_price_lyd",
  "vms_cost_price_lyd",
  "latest_vms_machine_id",
  "latest_machine_name",
  "last_seen_at",
].join(", ");

function formatDate(value: string | null | undefined) {
  if (!value) return "Not seen yet";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

export default async function EditVmsProductMappingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!canManageVmsMappings(profile)) {
    return (
      <>
        <PageHeader
          title="Edit VMS Product Mapping"
          subtitle="Connect this imported VMS product to the correct Snacky product."
          action={<SecondaryButton href="/vms-mappings">Back to mappings</SecondaryButton>}
        />
        <ErrorState title="VMS mapping access required" body="You do not have permission to load VMS product mappings." />
      </>
    );
  }

  const { id } = await params;
  const { error } = await searchParams;
  const supabase = await getAuthenticatedSupabaseServerClient();

  if (!supabase) {
    return (
      <>
        <ErrorState title="Mapping unavailable" body="Supabase is not configured." action={<SecondaryButton href="/vms-mappings">Back to mappings</SecondaryButton>} />
      </>
    );
  }

  const [{ data: mapping, error: mappingError }, { data: products }] = await Promise.all([
    supabase
      .from("vms_product_mappings")
      .select(mappingSelect)
      .eq("id", id)
      .maybeSingle<VmsProductMapping>(),
    supabase.from("products").select("id, name, sku").eq("active", true).order("name"),
  ]);

  if (mappingError) console.error("[vms-mappings:edit] Failed to load mapping", { id, error: mappingError });
  if (!mapping) notFound();

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="Edit VMS Product Mapping"
          subtitle="Connect this imported VMS product to the correct Snacky product."
          action={<SecondaryButton href="/vms-mappings">Back to mappings</SecondaryButton>}
        />

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
            {error}
          </div>
        ) : null}

        <LocalDraftForm action={updateVmsProductMapping} formType="vms-mapping" draftKeyParts={[mapping.id]} className="space-y-6">
          <input type="hidden" name="id" value={mapping.id} />

          <FormSection title="VMS product">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="VMS Product ID">
                <input value={mapping.vms_product_code ?? mapping.vms_product_id ?? ""} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="VMS Product Name">
                <input value={mapping.vms_product_name} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="VMS Selling Price LYD">
                <input value={formatMoney(mapping.vms_selling_price_lyd)} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="VMS Cost Price LYD" hint="Recorded from VMS only. It does not overwrite latest purchase cost automatically.">
                <input value={formatMoney(mapping.vms_cost_price_lyd, 4)} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="Latest Machine">
                <input value={mapping.latest_machine_name || mapping.latest_vms_machine_id || "-"} readOnly className="field-input bg-slate-50" />
              </FormField>
              <FormField label="Last Seen">
                <input value={formatDate(mapping.last_seen_at)} readOnly className="field-input bg-slate-50" />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Snacky mapping">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Select Snacky Product" hint="Only real active products from the products table are available.">
                <select name="product_id" defaultValue={mapping.snacky_product_id ?? mapping.product_id ?? ""} className="field-input">
                  <option value="">Unmapped</option>
                  {(products ?? []).map((product: ProductOption) => (
                    <option key={product.id} value={product.id}>
                      {product.name}{product.sku ? ` (${product.sku})` : ""}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Status">
                <select name="status" defaultValue={mapping.status ?? mapping.match_status ?? "needs_review"} className="field-input">
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              {statusOptions.map((option) => (
                <div key={option.value} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-2"><StatusBadge status={option.value} /></div>
                  <p className="text-sm text-slate-600">{option.label}: {option.helper}</p>
                </div>
              ))}
            </div>
          </FormSection>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button className="btn-primary">Save mapping</button>
            <SecondaryButton href="/vms-mappings">Cancel</SecondaryButton>
          </div>
        </LocalDraftForm>
      </FormPageLayout>
    </>
  );
}
