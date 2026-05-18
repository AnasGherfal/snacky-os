import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { resolveProductImageUrl } from "@/lib/product-images";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function createProduct(fd: FormData) {
  "use server";
  const s = getSupabaseServerClient();
  if (!s) return;
  const profile = await getCurrentProfile();

  const { imageUrl, uploadUnavailable } = await resolveProductImageUrl(s, fd);
  const product = {
    sku: String(fd.get("sku") || "").trim(),
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
    case_quantity: Number(fd.get("case_quantity") || 1),
    image_url: imageUrl,
    active: String(fd.get("active") || "true") === "true",
  };

  if (!product.sku || !product.name) return;
  const { data } = await s.from("products").insert(product).select("id, sku, name, category, brand, active").single();
  if (data) {
    await logActivity({
      profile,
      action: "create",
      entityType: "product",
      entityId: data.id,
      entityLabel: data.name,
      afterData: data,
      summary: `Created product ${data.name}`,
    });
  }
  revalidatePath("/products");
  redirect(uploadUnavailable ? "/products?imageUpload=storage-unavailable" : "/products");
}

export default async function NewProductPage() {
  const s = getSupabaseServerClient();
  const { data: suppliers } = s ? await s.from("suppliers").select("id,name").order("name") : { data: [] };

  return (
    <AppShell>
      <FormPageLayout>
        <PageHeader title="Create product" subtitle="Add a product used in machines and storage operations." />
        <form action={createProduct} className="space-y-5">
          <FormSection title="Product details">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="SKU" required hint="Snacky internal product code. Stable and unique."><input required name="sku" placeholder="SNK-COLA-330" className="field-input" /></FormField>
              <FormField label="Barcode" hint="Barcode scanned or entered for product identification."><input name="barcode" placeholder="6291234567890" className="field-input" /></FormField>
              <FormField label="Product Name" required hint="Exact name used internally."><input required name="name" placeholder="Cola 330ml" className="field-input" /></FormField>
              <FormField label="Category" required><select name="category" className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
              <FormField label="Brand"><input name="brand" placeholder="Brand name" className="field-input" /></FormField>
              <FormField label="Supplier"><select name="supplier_id" className="field-input"><option value="">Select supplier</option>{suppliers?.map((supplier: any) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></FormField>
              <FormField label="Manual Cost Price LYD" hint="Fallback only. Received purchases will replace this with latest purchase cost."><input type="number" step="0.0001" name="current_cost_price_lyd" placeholder="1.2000" className="field-input" /></FormField>
              <FormField label="Selling Price LYD" hint="Manual selling price until a VMS price import updates it."><input type="number" step="0.01" name="current_selling_price_lyd" placeholder="2.00" className="field-input" /></FormField>
              <FormField label="Case Quantity" hint="Units per carton/case."><input type="number" name="case_quantity" placeholder="24" className="field-input" /></FormField>
              <FormField label="Active" hint="Inactive products stay in history but are hidden from new operations."><select name="active" className="field-input"><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
            </div>
          </FormSection>

          <FormSection title="Product image">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Upload image" hint="Stored in the local product image bucket. PNG, JPG, and WEBP are supported. Maximum 5MB.">
                <input name="image_file" type="file" accept="image/png,image/jpeg,image/webp" className="field-input" />
              </FormField>
              <FormField label="Image URL fallback" hint="Optional public URL if you do not upload a file.">
                <input name="image_url" type="url" placeholder="https://example.com/product.jpg" className="field-input" />
              </FormField>
            </div>
          </FormSection>

          <div className="flex gap-3"><PrimaryButton>Save product</PrimaryButton><SecondaryButton href="/products">Cancel</SecondaryButton></div>
        </form>
      </FormPageLayout>
    </AppShell>
  );
}
