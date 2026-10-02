import { PageHeader, SecondaryButton, ErrorState } from "@/components/ui";
import { RestockBuyingList } from "@/components/RestockBuyingList";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getServerI18n } from "@/lib/i18n/server";
import type { BoxProduct } from "@/lib/purchase-boxes";

export const dynamic = "force-dynamic";
export default async function RestockShoppingListPage() {
  const profile = await requireCurrentProfileForPath("/restock-priority");
  const {locale} = await getServerI18n(), ar = locale === "ar";
  const db = getSupabaseAdminClient() ?? await getAuthenticatedSupabaseServerClient();
  const products:BoxProduct[] = [];
  let failed = !db;
  if (db) for (let start=0;start<50000;start+=500) {
    const result = await db.from("products").select("id, name, active, case_quantity, last_purchase_cost_lyd, current_cost_price_lyd")
      .eq("active",true).order("id").range(start,start+499);
    if (result.error) {failed=true;break;}
    products.push(...(result.data??[]));
    if ((result.data??[]).length<500) break;
    if (start===49500) failed=true;
  }
  return <div className="space-y-5">
    <PageHeader title={ar ? "قائمة الشراء المحفوظة — صناديق" : "Buying List — Whole boxes"}
      subtitle={ar ? "راجع عدد الصناديق ثم أنشئ مسودة الشراء." : "Review box counts, then create your purchase draft."}
      action={<SecondaryButton href="/restock-priority/purchase-list">{ar ? "الاقتراحات التلقائية" : "Automatic Purchase List"}</SecondaryButton>}/>
    {failed ? <ErrorState title={ar ? "تعذر تحميل أحجام الصناديق" : "Box sizes unavailable"} body={ar ? "أعد التحميل قبل تعديل أو إنشاء شراء. لم يتم افتراض صندوق بحجم 1." : "Reload before editing or creating a purchase. A one-unit box has not been assumed."}/> : <RestockBuyingList products={products} userId={profile.id}/>}
  </div>;
}
