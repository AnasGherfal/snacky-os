import { PageHeader, SecondaryButton } from "@/components/ui";
import { RestockBuyingList } from "@/components/RestockBuyingList";
import { requireCurrentProfileForPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RestockShoppingListPage() {
  await requireCurrentProfileForPath("/restock-priority");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buying List"
        subtitle="Products selected from Restock Priority, with editable quantities and an estimated total based on each product’s latest purchase cost."
        breadcrumbs={[{ label: "Restock Priority", href: "/restock-priority" }, { label: "Buying List" }]}
        action={<SecondaryButton href="/restock-priority">Back to planning</SecondaryButton>}
      />
      <RestockBuyingList />
    </div>
  );
}
