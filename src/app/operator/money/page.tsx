import { redirect } from "next/navigation";
import OperatorMoneyLedgerClient from "@/app/operator-money/OperatorMoneyLedgerClient";
import { PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function OperatorMoneyPage({ searchParams }: { searchParams: Promise<{ personId?: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/operator/money")}`);
  const manager = isOwnerAdminRole(profile);
  const params = await searchParams;
  const initialPersonId = manager ? String(params.personId ?? "") : String(profile.team_member_id ?? "");
  if (!manager && !initialPersonId) redirect("/unauthorized");
  const { locale, t } = await getServerI18n();

  return <div className="space-y-6">
    <PageHeader
      title={t("My Money", locale === "ar" ? "حسابي المالي" : "My Money")}
      subtitle={manager
        ? (locale === "ar" ? "مراجعة أرصدة المشغلين ومشترياتهم ومصروفاتهم وتسوياتهم." : "Review operator balances, purchases, expenses, and settlements.")
        : (locale === "ar" ? "سجّل مشترياتك الشخصية ومصروفات العمل وراجع رصيدك وسجلك." : "Record personal purchases and work expenses, then review your balance and history.")}
    />
    <OperatorMoneyLedgerClient initialPersonId={initialPersonId} locale={locale} />
  </div>;
}
