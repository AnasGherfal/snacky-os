import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/AppShell";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function createProduct(fd: FormData){"use server"; const s=getSupabaseServerClient(); if(!s) return; const p={sku:String(fd.get("sku")||"").trim(),barcode:String(fd.get("barcode")||"")||null,name:String(fd.get("name")||"").trim(),category:String(fd.get("category")||"snack"),brand:String(fd.get("brand")||"")||null,supplier_id:String(fd.get("supplier_id")||"")||null,cost_price:Number(fd.get("cost_price")||0),selling_price:Number(fd.get("selling_price")||0),case_quantity:Number(fd.get("case_quantity")||1),active:String(fd.get("active")||"true")==="true"}; if(!p.sku||!p.name)return; await s.from("products").insert(p); revalidatePath('/products'); redirect('/products'); }

export default async function NewProductPage(){const s=getSupabaseServerClient(); const {data:suppliers}=s?await s.from('suppliers').select('id,name').order('name'):{data:[]};
return <AppShell><FormPageLayout><PageHeader title="Create product" subtitle="Add a product used in machines and storage operations."/><form action={createProduct} className="space-y-5"><FormSection title="Product details"><div className="grid gap-4 md:grid-cols-2">
<FormField label="SKU" required hint="Snacky internal product code. Stable and unique."><input required name="sku" placeholder="SNK-COLA-330" className="field-input"/></FormField>
<FormField label="Barcode" hint="Barcode scanned or entered for product identification."><input name="barcode" placeholder="6291234567890" className="field-input"/></FormField>
<FormField label="Product Name" required hint="Exact name used internally."><input required name="name" placeholder="Cola 330ml" className="field-input"/></FormField>
<FormField label="Category" required><select name="category" className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
<FormField label="Brand"><input name="brand" placeholder="Brand name" className="field-input"/></FormField>
<FormField label="Supplier"><select name="supplier_id" className="field-input"><option value="">Select supplier</option>{suppliers?.map((s:any)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
<FormField label="Cost Price LYD" hint="Average purchase cost per unit."><input type="number" step="0.01" name="cost_price" placeholder="1.20" className="field-input"/></FormField>
<FormField label="Selling Price LYD" hint="Selling price in the machine."><input type="number" step="0.01" name="selling_price" placeholder="2.00" className="field-input"/></FormField>
<FormField label="Case Quantity" hint="Units per carton/case."><input type="number" name="case_quantity" placeholder="24" className="field-input"/></FormField>
<FormField label="Active" hint="Inactive products stay in history but are hidden from new operations."><select name="active" className="field-input"><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
</div></FormSection><div className="flex gap-3"><PrimaryButton>Save product</PrimaryButton><SecondaryButton href="/products">Cancel</SecondaryButton></div></form></FormPageLayout></AppShell>}
