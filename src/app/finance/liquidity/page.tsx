import Link from "next/link";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { EmptyState, FormField, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { recordOwnerLiquidityAttestation } from "@/lib/liquidity-actions";
import { calculateLiquidityPosition, isCurrentLiquidityAttestation } from "@/lib/liquidity-position";

export const dynamic = "force-dynamic";

type Snapshot = {
  id: string;
  as_of_date: string;
  cash_on_hand_lyd: number | string;
  bank_lyd: number | string;
  custody_lyd: number | string;
  immediate_debt_lyd: number | string;
  short_term_debt_lyd: number | string;
  immediate_debt_due_date: string | null;
  short_term_debt_due_date: string | null;
  custody_details: string | null;
  debt_details: string | null;
  created_at: string;
};
const lyd = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LYD`;

export default async function OwnerLiquidityPage({ searchParams }: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["owner"])) redirect("/unauthorized");
  const db = await getAuthenticatedSupabaseServerClient();
  if (!db) return <EmptyState title="Owner liquidity unavailable" body="Finance database session unavailable." />;
  const { saved, error } = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const snapshots = await db.from("owner_liquidity_attestations")
    .select("id,as_of_date,cash_on_hand_lyd,bank_lyd,custody_lyd,immediate_debt_lyd,short_term_debt_lyd,immediate_debt_due_date,short_term_debt_due_date,custody_details,debt_details,created_at")
    .order("created_at", { ascending: false }).limit(10);
  if (snapshots.error) {
    return <div className="space-y-4"><PageHeader title="Owner liquidity" subtitle="Physical cash and upcoming repayments, separate from the Finance ledger." />
      <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        The owner liquidity module is not installed or the source could not be verified. Apply its reviewed migration before using this page. No numbers were assumed to be zero.
      </div><SecondaryButton href="/finance/growth-decisions">Growth Decisions</SecondaryButton></div>;
  }

  const history = (snapshots.data ?? []) as Snapshot[];
  const latest = history[0] ?? null;
  const current = latest && isCurrentLiquidityAttestation(latest.as_of_date, today);
  const totals = latest ? calculateLiquidityPosition({
    cashOnHandLyd: Number(latest.cash_on_hand_lyd),
    bankLyd: Number(latest.bank_lyd),
    custodyLyd: Number(latest.custody_lyd),
    immediateDebtLyd: Number(latest.immediate_debt_lyd),
    shortTermDebtLyd: Number(latest.short_term_debt_lyd),
  }) : null;

  return <div className="space-y-6">
    <PageHeader title="Owner liquidity / السيولة" subtitle="Owner-attested physical funds, custody cash and debts. These are NOT ledger revenue, repayments, or proof of available profit."
      action={<SecondaryButton href="/finance/growth-decisions">Growth Decisions / قرارات النمو</SecondaryButton>} />
    {saved ? <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">Saved a new immutable liquidity snapshot. No Finance ledger transaction was created.</p> : null}
    {error ? <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{error}</p> : null}

    {latest && totals ? <section className="surface-card space-y-3">
      <div className="flex flex-wrap justify-between gap-2"><h2 className="text-lg font-semibold">Latest reported position / آخر وضع مالي</h2>
        <span className={current ? "text-emerald-700" : "text-amber-800"}>{current ? "Current attestation" : "Stale — refresh before a purchase"} · {latest.as_of_date}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {([
          ["Cash + bank under Snacky control", totals.directlyAccessible],
          ["With other people (not spendable)", totals.physicallyHeldElsewhere],
          ["All funds including custody", totals.totalFundsIncludingCustody],
          ["Debts still to repay", totals.totalDebts],
          ["After debts — directly accessible", totals.afterAllDebts],
          ["After debts — including custody", totals.afterAllDebtsIncludingCustody],
        ] as const).map(([label,value]) => <div key={label} className="rounded-xl border border-slate-200 p-3">
          <p className="text-xs text-slate-600">{label}</p><strong className="mt-2 block text-xl">{lyd(value)}</strong>
        </div>)}
      </div>
      <p className="text-sm text-slate-700">Cash: {lyd(Number(latest.cash_on_hand_lyd))} · Bank: {lyd(Number(latest.bank_lyd))} · After immediate repayment: {lyd(totals.afterImmediateDebt)}.</p>
      {latest.immediate_debt_due_date || latest.short_term_debt_due_date ? <p className="text-sm text-amber-950">
        Debt due dates: {latest.immediate_debt_due_date ?? "not supplied"} / {latest.short_term_debt_due_date ?? "not supplied"}.
      </p> : null}
      {latest.custody_details ? <p className="text-sm text-slate-700">Money held elsewhere: {latest.custody_details}</p> : null}
      {latest.debt_details ? <p className="text-sm text-slate-700">Debt details: {latest.debt_details}</p> : null}
      <p className="text-xs text-amber-900">Custody money is not counted as spendable until physically returned. Debts are reserved even if borrowed proceeds remain in the bank. Expenses, rent, stock purchases, and future cash needs are not included in these figures. Reconcile against the actual Finance ledger separately.</p>
    </section> : <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">No owner cash count has been recorded. Expansion should remain on hold rather than treating unverified liquidity as zero or as freely spendable cash.</div>}

    <section className="surface-card">
      <h2 className="text-lg font-semibold">Record a new cash and debt count / تسجيل رصيد جديد</h2>
      <p className="mb-4 mt-1 text-sm text-slate-600">Append-only management snapshot. Enter the money actually held at this moment and the full balances you still owe. Do not enter the original loan as another cash asset when its proceeds are already in the bank.</p>
      <form action={recordOwnerLiquidityAttestation} className="space-y-4">
        <input type="hidden" name="client_submission_id" value={crypto.randomUUID()} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Count date / تاريخ الجرد"><input type="date" name="as_of_date" defaultValue={today} max={today} className="field-input" required /></FormField>
          <FormField label="Cash physically held / النقد الموجود"><input type="number" name="cash_on_hand_lyd" min="0" step="0.01" className="field-input" required /></FormField>
          <FormField label="Bank balance / رصيد المصرف"><input type="number" name="bank_lyd" min="0" step="0.01" className="field-input" required /></FormField>
          <FormField label="Cash with other people (additional) / النقد لدى الغير"><input type="number" name="custody_lyd" min="0" step="0.01" className="field-input" required /></FormField>
          <FormField label="Immediate debt due / دين مستحق قريباً"><input type="number" name="immediate_debt_lyd" min="0" step="0.01" className="field-input" required /></FormField>
          <FormField label="Other short-term debt / دين قصير الأجل"><input type="number" name="short_term_debt_lyd" min="0" step="0.01" className="field-input" required /></FormField>
          <FormField label="First debt due date (if known)"><input type="date" name="immediate_debt_due_date" className="field-input" /></FormField>
          <FormField label="Second debt due date (if known)"><input type="date" name="short_term_debt_due_date" className="field-input" /></FormField>
          <FormField label="Custodian names and reason"><textarea name="custody_details" className="field-input" maxLength={1000} rows={2} placeholder="Holder, amount, intended payment, whether returned" /></FormField>
          <FormField label="Repayment terms and creditor notes"><textarea name="debt_details" className="field-input" maxLength={1000} rows={2} placeholder="Creditor and repayment details; do not include passwords or bank credentials" /></FormField>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" name="confirmed_no_double_count" required className="mt-1" />
          <span>I confirm cash held by other people is NOT included in cash or bank above, and borrowed funds remaining in the bank are NOT added again. Debts shown are still outstanding.</span>
        </label>
        <div className="flex flex-wrap gap-3"><FormSubmitButton pendingLabel="Saving count...">Save owner snapshot</FormSubmitButton><SecondaryButton href="/finance">Finance ledger</SecondaryButton></div>
      </form>
    </section>
    <section className="surface-card">
      <h2 className="mb-2 text-lg font-semibold">Recent owner attestations</h2>
      {history.length ? <div className="space-y-2">{history.map(row=><div key={row.id} className="flex flex-wrap justify-between gap-2 border-b border-slate-200 py-2 text-sm">
        <span>{row.as_of_date} · {new Date(row.created_at).toLocaleDateString("en-GB")}</span>
        <span>Cash {lyd(Number(row.cash_on_hand_lyd))} · Bank {lyd(Number(row.bank_lyd))} · Debts {lyd(Number(row.immediate_debt_lyd)+Number(row.short_term_debt_lyd))}</span>
      </div>)}</div> : <p className="text-sm text-slate-500">No snapshots yet.</p>}
      <p className="mt-3 text-xs text-slate-500">Snapshots are historical evidence, not cash movements. Correct a mistake by adding a new attestation; never create balancing revenue to match the Finance ledger.</p>
    </section>
    <p className="text-sm text-slate-600">Need to reconcile bookkeeping? <Link href="/finance/transactions" className="underline">Review transactions</Link> before changing any financial records.</p>
  </div>;
}
