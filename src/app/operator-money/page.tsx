import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import OperatorMoneyLedgerClient from "./OperatorMoneyLedgerClient";

export const dynamic = "force-dynamic";

export default async function OperatorMoneyPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/operator-money")}`);
  return (
    <>
      <PageHeader title="Operator Money & Debts" subtitle="Personal purchases, operator advances, submitted expenses, repayments, and returned money. This ledger is separate from Finance and route sales." />
      <OperatorMoneyLedgerClient />
    </>
  );
}
