import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ErrorState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { resolveProductImageUrl } from "@/lib/product-images";
import { isSkuDuplicateError, resolveProductSku } from "@/lib/product-sku";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function safeReturnTo(value: FormDataEntryValue | string | null | undefined) {
  const path = String(value ?? "").trim();
  return path.startsWith("/") && !path.startsWith("//") ? path : "";
}

async function createProduct(fd: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/products/new");
  const s = getSupabaseServerClient();
  if (!s) redirect("/products/new?error=Supabase%20is%20not%20configured.");
  const returnTo = safeReturnTo(fd.get("return_to"));

  const { imageUrl, uploadUnavailable, uploadError } = await resolveProductImageUrl(s, fd);
  const skuMode = String(fd.get("sku_mode") || "auto");
  let sku = "";
  try {
    sku = await resolveProductSku({
      supabase: s,
      manualSku: skuMode === "manual" ? fd.get("sku") : null,
      vmsProductCode: skuMode === "manual" ? null : fd.get("vms_product_code"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate product code.";
    redirect(`/products/new?error=${encodeURIComponent(message)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }

  const product = {
    sku,
    barcode: String(fd.get("barcode") || "") || null,
    name: String(fd.get("name") || "").trim(),
    category: String(fd.get("category") || "snack"),
    brand: String(fd.get("brand") || "") || null,
    supplier_id: String(fd.get("supplier_id") || "") || null,
    cost_price: Number(fd.get("current_cost_price_lyd") || 0),
    selling_price: Number(fd.get("current_selling_price_lyd") || 0),
    current_cost_price_lyd: Number(fd.get("current_cost_price_lyd") || 0),
    current_selling_price_lyd: Number(fd.get("current_selling_price_lyd") || 0),
    cost_price_source: Number(fd.get("current_cost_price_lyd") || 0) > 0 ? "manual" : "initial_import",
    selling_price_source: Number(fd.get("current_selling_price_lyd") || 0) > 0 ? "manual" : "initial_import",
    import_source: "manual",
    price_updated_at: new Date().toISOString(),
    case_quantity: Math.max(1, Math.floor(Number(fd.get("case_quantity") || 1) || 1)),
    image_url: imageUrl,
    active: String(fd.get("active") || "true") === "true",
  };

  if (!product.name) redirect(`/products/new?error=Product%20name%20is%20required.${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  const { data, error } = await s.from("products").insert(product).select("id, sku, name, category, brand, active").single();
  if (error || !data) {
    console.error("[products] Failed to create product", error);
    const message = isSkuDuplicateError(error) ? "Product code already exists. Use another code or leave it blank to auto-generate." : "Could not create product.";
    redirect(`/products/new?error=${encodeURIComponent(message)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }
  await logActivity({
    profile,
    action: "create",
    entityType: "product",
    entityId: data.id,
    entityLabel: data.name,
    afterData: data,
    summary: `Created product ${data.name}`,
  });
  revalidatePath("/products");
  const imageUpload = uploadError === "invalid_file" ? "invalid-file" : uploadUnavailable ? "storage-unavailable" : "";
  if (returnTo) redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}productCreated=1`);
  redirect(imageUpload ? `/products?imageUpload=${imageUpload}` : "/products");
}

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ error?: string; returnTo?: string }> }) {
  await requireCurrentProfileForPath("/products/new");
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  const s = getSupabaseServerClient();
  if (!s) {
    return (
      <>
        <ErrorState title="Products unavailable" body="Supabase is not configured, so Snacky OS cannot create products." />
      </>
    );
  }
  const { data: suppliers, error: suppliersError } = await s.from("suppliers").select("id,name").order("name");
  if (suppliersError) {
    console.error("[products] Failed to load suppliers for product form", suppliersError);
    return (
      <>
        <ErrorState title="Could not load product form" body="Snacky OS could not load suppliers for the product form." action={<SecondaryButton href="/products">Back to products</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader title="Create product" subtitle="Add a product used in machines and storage operations." />
        {params.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
        <form action={createProduct} className="space-y-5">
          <input type="hidden" name="return_to" value={returnTo} />
          <FormSection title="Product details">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">Product code</div>
                <p className="mt-1 text-sm text-slate-600">Product code will be generated automatically.</p>
                <p className="mt-1 text-xs text-slate-500">SKU is the internal/VMS product code used for matching and reports.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <label className="rounded-lg border border-slate-200 bg-white p-3 text-sm"><input type="radio" name="sku_mode" value="auto" defaultChecked className="mr-2" />Auto-generate SKU</label>
                  <label className="rounded-lg border border-slate-200 bg-white p-3 text-sm"><input type="radio" name="sku_mode" value="vms" className="mr-2" />Use VMS product code</label>
                  <label className="rounded-lg border border-slate-200 bg-white p-3 text-sm"><input type="radio" name="sku_mode" value="manual" className="mr-2" />Manual code override</label>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <FormField label="VMS product code" hint="Using VMS product code. Leave blank unless the VMS code is known."><input name="vms_product_code" placeholder="VMS goods/product code" className="field-input" /></FormField>
                  <FormField label="Manual SKU override" hint="Owner/admin only. Leave blank to generate the next Snacky code."><input name="sku" placeholder="SNK-P-0001" className="field-input" /></FormField>
                </div>
              </div>
              <FormField label="Barcode" hint="Barcode is the scannable product barcode, if available."><input name="barcode" placeholder="6291234567890" className="field-input" /></FormField>
              <FormField label="Product Name" required hint="Exact name used internally."><input required name="name" placeholder="Cola 330ml" className="field-input" /></FormField>
              <FormField label="Category" required><select name="category" className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
              <FormField label="Brand"><input name="brand" placeholder="Brand name" className="field-input" /></FormField>
              <FormField label="Supplier"><select name="supplier_id" className="field-input"><option value="">Select supplier</option>{suppliers?.map((supplier: any) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></FormField>
              <FormField label="Manual Cost Price LYD" hint="Fallback only. Received purchases will replace this with latest purchase cost."><input type="number" step="0.0001" name="current_cost_price_lyd" placeholder="1.2000" className="field-input" /></FormField>
              <FormField label="Selling Price LYD" hint="Manual selling price until a VMS price import updates it."><input type="number" step="0.01" name="current_selling_price_lyd" placeholder="2.00" className="field-input" /></FormField>
              <FormField label="Units per box / Case quantity" hint="Used when receiving purchases. Example: Pepsi box = 24 cans."><input type="number" min="1" name="case_quantity" placeholder="24" className="field-input" /></FormField>
              <FormField label="Active" hint="Inactive products stay in history but are hidden from new operations."><select name="active" className="field-input"><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
            </div>
          </FormSection>

          <FormSection title="Product image">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Upload image" hint="Stored in product-images when Supabase Storage is configured. PNG, JPG, and WEBP are supported. Maximum 5MB.">
                <input name="image_file" type="file" accept="image/png,image/jpeg,image/webp" className="field-input" />
              </FormField>
              <FormField label="Image URL fallback" hint="Optional public URL if you do not upload a file.">
                <input name="image_url" type="url" placeholder="https://example.com/product.jpg" className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <div className="flex gap-3"><PrimaryButton>Save product</PrimaryButton><SecondaryButton href={returnTo || "/products"}>Cancel</SecondaryButton></div>
        </form>
      </FormPageLayout>
    </>
  );
}
