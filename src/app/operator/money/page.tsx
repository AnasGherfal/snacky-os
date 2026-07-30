import { redirect } from "next/navigation";
import OperatorMoneyLedgerClient from "@/app/operator-money/OperatorMoneyLedgerClient";
import { PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function OperatorMoneyPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=/operator/money");
  if (!profile.team_member_id) redirect("/unauthorized");
  const { locale, t } = await getServerI18n();

  return <div className="space-y-6">
    <PageHeader
      title={t("My Money", "My Money")}
      subtitle={t("Record personal products taken from storage and submit Snacky work expenses.", "Record personal products taken from storage and submit Snacky work expenses.")}
      action={<SecondaryButton href={`/team/${profile.team_member_id}`}>{t("My profile", "My profile")}</SecondaryButton>}
    />
    <OperatorMoneyLedgerClient initialPersonId={profile.team_member_id} lockPerson locale={locale} selfServiceOnly />
  </div>;
}
