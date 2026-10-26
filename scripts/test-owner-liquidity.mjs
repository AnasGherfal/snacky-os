import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateLiquidityPosition, isCurrentLiquidityAttestation, parseLydInput } from "../src/lib/liquidity-position.ts";
import { buildGrowthDecision } from "../src/lib/growth-decision.ts";

const growth = readFileSync("src/app/finance/growth-decisions/page.tsx", "utf8");
const finance = readFileSync("src/app/finance/page.tsx", "utf8");
const form = readFileSync("src/app/finance/liquidity/page.tsx", "utf8");
const action = readFileSync("src/lib/liquidity-actions.ts", "utf8");
const sql = readFileSync("supabase/migrations/20261026143000_owner_liquidity_attestations.sql", "utf8");
const authz = readFileSync("src/lib/authz.ts", "utf8");

test("physical cash, bank, custodian funds and debts are each counted exactly once", () => {
  const p = calculateLiquidityPosition({
    cashOnHandLyd: 37715,
    bankLyd: 11659,
    custodyLyd: 2750,
    immediateDebtLyd: 20000,
    shortTermDebtLyd: 13000,
  });
  assert.equal(p.directlyAccessible, 49374);
  assert.equal(p.physicallyHeldElsewhere, 2750);
  assert.equal(p.totalFundsIncludingCustody, 52124);
  assert.equal(p.totalDebts, 33000);
  assert.equal(p.afterImmediateDebt, 29374);
  assert.equal(p.afterAllDebts, 16374);
  assert.equal(p.afterAllDebtsIncludingCustody, 19124);
});

test("money values are exact, nonnegative and bounded", () => {
  assert.equal(parseLydInput("1,000"), null);
  assert.equal(parseLydInput(""), null);
  assert.equal(parseLydInput("13.567"), null);
  assert.equal(parseLydInput("-1"), null);
  assert.equal(parseLydInput("NaN"), null);
  assert.equal(parseLydInput("13.25"), 13.25);
  assert.equal(parseLydInput("0"), 0);
  assert.throws(() => calculateLiquidityPosition({
    cashOnHandLyd: -1, bankLyd: 0, custodyLyd: 0, immediateDebtLyd: 0, shortTermDebtLyd: 0,
  }));
});

test("attestations stale after a week or dated in the future never authorize buying", () => {
  assert.equal(isCurrentLiquidityAttestation("2026-10-26","2026-10-26"),true);
  assert.equal(isCurrentLiquidityAttestation("2026-10-19","2026-10-26"),true);
  assert.equal(isCurrentLiquidityAttestation("2026-10-18","2026-10-26"),false);
  assert.equal(isCurrentLiquidityAttestation("2026-10-27","2026-10-26"),false);
  assert.equal(isCurrentLiquidityAttestation("2026-02-30","2026-03-01"),false);
});

test("growth decision holds buying when owner cash is unverified, and deducts debt", () => {
  const input = {
    cashAvailableLyd: 49374, shortTermDebtLyd: 33000, liquidityVerified: false,
    machineCostLyd: 20000, minimumCashReserveLyd: 15000, restockReserveLyd: 0,
    investorDueLyd: 0, minimumMonthlyOperatingProfitLyd: 100,
    averageMonthlyOperatingProfitLyd: 10000, averageMachineProfitAfterRentLyd: 5000,
    targetPaybackMonths: 20, acceptedLocationCount: 1, criticalRestockCount: 0,
    openCriticalIssueCount: 0, weakMachineCount: 0, historyMonthCount: 6,
    minimumHistoryMonths: 3, monthsWithRevenue: 6, costCoverageComplete: true,
    missingCostSalesCount: 0, missingCostRevenueLyd: 0, machineProfitCoverageComplete: true,
  };
  const unverified = buildGrowthDecision(input);
  assert.equal(unverified.code, "verify_liquidity");
  assert.notEqual(unverified.code, "buy_now");
  const checked = buildGrowthDecision({...input,liquidityVerified:true});
  assert.equal(checked.cashAfterCommitmentsLyd, 16374);
  assert.equal(checked.cashAfterMachinePurchaseLyd, -3626);
  assert.notEqual(checked.code, "buy_now");
  assert.ok(checked.priorities.some(p => p.key === "short_term_debt" && p.amountLyd === 33000));
});

test("owner attestation RLS is owner-only, append-only and ledger-independent", () => {
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke all on table public\.owner_liquidity_attestations from public, anon, authenticated/);
  assert.match(sql,/grant select, insert on table public\.owner_liquidity_attestations to authenticated/);
  assert.match(sql,/snacky_current_profile_has_any_role\(array\['owner'\]\)/);
  assert.match(sql,/created_by = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(sql,/grant .*update|grant .*delete|insert into public\.financial_transactions/i);
  assert.ok(!action.includes('.from("financial_transactions")'));
  assert.ok(action.includes('confirmed_no_double_count'));
  assert.ok(action.includes('error.code !== "23505"'));
});

test("owner pages use confirmed custody/loan positions, never ledger balance for expansion", () => {
  assert.ok(form.includes('hasAnyRole(profile, ["owner"])'));
  assert.ok(form.includes("Latest reported position"));
  assert.ok(form.includes("not spendable"));
  assert.ok(form.includes("immutable liquidity snapshot"));
  assert.ok(form.includes('form action={recordOwnerLiquidityAttestation}'));
  assert.ok(finance.includes('href="/finance/liquidity"'));
  assert.ok(growth.includes("liquidityVerified"));
  assert.ok(growth.includes("knownShortTermDebt"));
  assert.ok(growth.includes("cashAvailable: number | null = liquidity ? liquidity.directlyAccessible : null"));
  assert.ok(growth.includes("ledger balance (reconciliation only)") || growth.includes("Finance ledger balance (reconciliation only)"));
  assert.ok(growth.includes("cashAvailableLyd: cashAvailable ?? 0"));
  assert.ok(growth.includes("shortTermDebtLyd: knownShortTermDebt"));
});

test("liquidity route is owner-only ahead of generic finance role access", () => {
  assert.ok(authz.includes('if (matchesPrefix(pathname, ["/finance/liquidity"])) return hasAnyRole(user, ["owner"])'));
  const gate = authz.indexOf('matchesPrefix(pathname, ["/finance/liquidity"])');
  const fallback = authz.indexOf('matchesPrefix(pathname, ["/finance"])');
  assert.ok(gate >= 0 && fallback > gate);
});

test("Finance warns that ledger balances do not verify cash or outstanding debts", () => {
  assert.ok(finance.includes("Ledger balance is not freely spendable cash."));
  assert.ok(finance.includes("outstanding private loans"));
  assert.ok(growth.includes("reconciliationGap"));
});
