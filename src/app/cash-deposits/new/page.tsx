import { redirect } from "next/navigation";
import { CashBankDepositForm } from "@/components/CashCustodyForms";
import { EmptyState, ErrorState, FormPageLayout, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { recordCashBankDeposit } from "@/lib/cash-actions";

export const dynamic = "force-dynamic";

export default async function NewCashDepositPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error = "" } = await searchParams;
  const profile = await getCurrentProfile();
  const context = profile ? { id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status } : null;
  if (!profile || !canAccessPath(context, "/cash-deposits/new")) redirect("/unauthorized");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Bank deposit unavailable" body="Supabase is not configured." />;
  const { data, error: loadError } = await supabase
    .from("cash_collections")
    .select("id, cash_bag_id, actual_cash_collected, reconciled_at")
    .eq("custody_status", "reconciled")
    .neq("review_status", "voided")
    .order("reconciled_at", { ascending: true })
    .limit(500);
  if (loadError) {
    console.error("[cash] Failed to load bankable cash batches", loadError);
    return <ErrorState title="Could not load reconciled cash" body="The bankable cash query failed." action={<SecondaryButton href="/cash-deposits/new">Retry</SecondaryButton>} />;
  }
  const batches = (data ?? []).filter((row: any) => Number(row.actual_cash_collected ?? 0) > 0);

  return (
    <FormPageLayout>
      <PageHeader title="Record Cash Bank Deposit" subtitle="Select all reconciled bags on the receipt. Snacky OS rejects any deposit whose total differs from the selected physical counts." breadcrumbs={[{ label: "Cash Custody", href: "/cash-collections" }, { label: "Bank Deposits", href: "/cash-deposits" }, { label: "New deposit" }]} action={<SecondaryButton href="/cash-deposits">Back</SecondaryButton>} />
      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {!batches.length ? <EmptyState title="No cash is ready to bank" body="A cash bag must be stored, counted, and reconciled—with any variance approved—before it appears here." action={<SecondaryButton href="/cash-collections">Open cash custody</SecondaryButton>} /> : <CashBankDepositForm action={recordCashBankDeposit} batches={batches.map((row: any) => ({ id: row.id, bagId: row.cash_bag_id ?? row.id.slice(0, 8), countedAmount: Number(row.actual_cash_collected ?? 0), reconciledAt: row.reconciled_at }))} clientSubmissionId={crypto.randomUUID()} />}
    </FormPageLayout>
  );
}
