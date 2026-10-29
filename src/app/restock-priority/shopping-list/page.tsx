import { PageHeader, SecondaryButton } from "@/components/ui";
import { DraftMarketChecklist } from "@/components/DraftMarketChecklist";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export default async function RestockShoppingListPage({ searchParams }: { searchParams: Promise<{ suggestions?: string }> }) {
  const profile = await requireCurrentProfileForPath("/restock-priority/shopping-list");
  const {locale} = await getServerI18n(), ar = locale === "ar", params = await searchParams;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find(value => value.type === name)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return <div className="space-y-5">
    <PageHeader title={ar ? "قائمة السوق" : "Shopping checklist"}
      subtitle={ar ? "أضف ما تحتاجه، اختر البدائل المقبولة، وتابع ما تبقى للشراء." : "Add what you need, choose acceptable alternatives, and track what is left to get."}
      action={<SecondaryButton href="/restock-priority/purchase-list">{ar ? "اقتراحات المبيعات" : "Sales suggestions"}</SecondaryButton>}/>
    <DraftMarketChecklist userId={profile.id} today={today} fromSuggestions={params.suggestions === "1"}/>
  </div>;
}
