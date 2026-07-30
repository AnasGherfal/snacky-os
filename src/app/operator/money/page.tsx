import { redirect } from "next/navigation";
import OperatorMoneyLedgerClient from "@/app/operator-money/OperatorMoneyLedgerClient";
import { getCurrentProfile } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function OperatorMoneyPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login?next=/operator/money");
  if (!profile.team_member_id) redirect("/unauthorized");
  const { locale } = await getServerI18n();

  return <OperatorMoneyLedgerClient initialPersonId={profile.team_member_id} lockPerson locale={locale} selfServiceOnly />;
}
