import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { EmptyState, FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function saveSupplier(formData: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) return;
  const id = String(formData.get("id") || "");
  await supabase
    .from("suppliers")
    .update({
      name: String(formData.get("name") || "").trim(),
      contact_name: String(formData.get("contact_name") || "") || null,
      phone: String(formData.get("phone") || "") || null,
      payment_terms: String(formData.get("payment_terms") || "") || null,
      notes: String(formData.get("notes") || "") || null,
    })
    .eq("id", id);
  revalidatePath("/suppliers");
  redirect("/suppliers");
}

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();
  const { data: supplier } = supabase ? await supabase.from("suppliers").select("*").eq("id", id).maybeSingle() : { data: null };

  if (!supplier) {
    return (
      <>
        <EmptyState title="Supplier not found" body="This supplier may have been removed or you may not have access to it." action={<SecondaryButton href="/suppliers">Back to suppliers</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <FormPageLayout>
        <PageHeader
          title={`Edit supplier: ${supplier.name}`}
          subtitle="Update supplier contact details used by purchases and receipt records."
          breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Suppliers", href: "/suppliers" }, { label: supplier.name }]}
          action={<SecondaryButton href="/suppliers">Back to suppliers</SecondaryButton>}
        />
        <form action={saveSupplier} className="space-y-5">
          <input type="hidden" name="id" value={supplier.id} />
          <FormSection title="Supplier details" description="Keep supplier data accurate so purchase follow-up and finance review have the right context.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Supplier name" required>
                <input required name="name" defaultValue={supplier.name} className="field-input" />
              </FormField>
              <FormField label="Contact name">
                <input name="contact_name" defaultValue={supplier.contact_name || ""} className="field-input" />
              </FormField>
              <FormField label="Phone">
                <input name="phone" defaultValue={supplier.phone || ""} className="field-input" />
              </FormField>
              <FormField label="Payment terms">
                <input name="payment_terms" defaultValue={supplier.payment_terms || ""} className="field-input" />
              </FormField>
              <div className="md:col-span-2">
                <FormField label="Notes">
                  <textarea name="notes" defaultValue={supplier.notes || ""} rows={4} className="field-input" />
                </FormField>
              </div>
            </div>
          </FormSection>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Save changes</PrimaryButton>
            <SecondaryButton href="/suppliers">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </>
  );
}
