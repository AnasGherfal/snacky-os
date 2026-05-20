import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FormField, FormPageLayout, FormSection, PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { getSupabaseServerClient } from "@/lib/supabase-server";

async function createSupplier(formData: FormData) {
  "use server";
  const supabase = getSupabaseServerClient();
  if (!supabase) return;
  await supabase.from("suppliers").insert({
    name: String(formData.get("name") || "").trim(),
    contact_name: String(formData.get("contact_name") || "") || null,
    phone: String(formData.get("phone") || "") || null,
    payment_terms: String(formData.get("payment_terms") || "") || null,
  });
  revalidatePath("/suppliers");
  redirect("/suppliers");
}

export default function NewSupplierPage() {
  return (
    <>
      <FormPageLayout>
        <PageHeader
          title="New Supplier"
          subtitle="Create a supplier record for purchases and receipt history."
          breadcrumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Suppliers", href: "/suppliers" }, { label: "New supplier" }]}
          action={<SecondaryButton href="/suppliers">Back to suppliers</SecondaryButton>}
        />
        <form action={createSupplier} className="space-y-5">
          <FormSection title="Supplier details" description="Use a clear company name and optional contact/payment notes for purchase follow-up.">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Supplier name" required>
                <input required name="name" className="field-input" placeholder="Supplier name" />
              </FormField>
              <FormField label="Contact name">
                <input name="contact_name" className="field-input" placeholder="Primary contact" />
              </FormField>
              <FormField label="Phone">
                <input name="phone" className="field-input" placeholder="+218..." />
              </FormField>
              <FormField label="Payment terms">
                <input name="payment_terms" className="field-input" placeholder="Cash, credit, weekly settlement..." />
              </FormField>
            </div>
          </FormSection>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton>Add supplier</PrimaryButton>
            <SecondaryButton href="/suppliers">Cancel</SecondaryButton>
          </div>
        </form>
      </FormPageLayout>
    </>
  );
}
