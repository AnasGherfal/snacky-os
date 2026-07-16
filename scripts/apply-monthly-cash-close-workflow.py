from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value)


def replace_once(source: str, label: str, before: str, after: str) -> str:
    count = source.count(before)
    if count == 0 and after in source:
        return source
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


def replace_regex_once(source: str, label: str, pattern: str, after: str) -> str:
    matches = list(re.finditer(pattern, source, flags=re.S))
    if not matches and after in source:
        return source
    if len(matches) != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {len(matches)}")
    return re.sub(pattern, lambda _: after, source, count=1, flags=re.S)


# Cash actions: no expected amount per individual pickup.
cash_actions = read("src/lib/cash-actions.ts")
expected_line = '  const expectedCash = optionalAmount(formData.get("expected_cash_lyd"));'
if expected_line in cash_actions:
    count = cash_actions.count(expected_line)
    if count != 2:
        raise RuntimeError(f"create/update expected cash: expected two matches, found {count}")
    cash_actions = cash_actions.replace(expected_line, "  const expectedCash = null;")
cash_actions = replace_once(
    cash_actions,
    "confirm expected cash",
    '''  const expectedFromForm = optionalAmount(formData.get("expected_cash_lyd"));
  const expectedCash = expectedFromForm ?? (before.vms_expected_cash === null || before.vms_expected_cash === undefined ? null : Number(before.vms_expected_cash));''',
    "  const expectedCash = null;",
)
write("src/lib/cash-actions.ts", cash_actions)


# Cash collection list: pickup ledger only; monthly expected belongs in Finance Operations.
cash_list = read("src/app/cash-collections/page.tsx")
cash_list = replace_once(
    cash_list,
    "cash variance imports",
    'import { getCashCollectionStatus, isCriticalCashVariance, isLargeCashVariance } from "@/lib/cash-collections";',
    'import { getCashCollectionStatus } from "@/lib/cash-collections";',
)
cash_list = replace_regex_once(
    cash_list,
    "variance class helper",
    r"\nfunction varianceClassName\([\s\S]*?\n}\n\nexport default async function CashCollectionsPage",
    "\nexport default async function CashCollectionsPage",
)
cash_list = re.sub(r"\n  const totalExpected = activeRows\.reduce\([^\n]+\);", "", cash_list, count=1)
cash_list = re.sub(r"\n  const reviewCount = rows\.filter\([^\n]+\);", "", cash_list, count=1)
cash_list = replace_once(
    cash_list,
    "cash list subtitle",
    '        subtitle="Track route cash pickup, finance counting, variances, and linked money-in transactions."',
    '        subtitle="Record every physical cash pickup and counted amount. Expected cash and shortage/overage are reconciled for the full machine month in Finance Operations."',
)
cash_list = replace_once(
    cash_list,
    "cash list cards",
    '''          <div className="grid gap-4 sm:grid-cols-4">
            <SectionCard><div className="text-sm text-slate-500">Expected cash</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalExpected)}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalCounted)}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Pending count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{pendingCount}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Variance review</div><div className="mt-2 text-2xl font-semibold text-slate-900">{reviewCount}</div></SectionCard>
          </div>''',
    '''          <div className="grid gap-4 sm:grid-cols-4">
            <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalCounted)}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Collections on this page</div><div className="mt-2 text-2xl font-semibold text-slate-900">{activeRows.length}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Pending count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{pendingCount}</div></SectionCard>
            <SectionCard><div className="text-sm text-slate-500">Monthly close</div><div className="mt-3"><Link href="/finance/operations" className="link-secondary">Open reconciliation</Link></div></SectionCard>
          </div>''',
)
cash_list = replace_once(
    cash_list,
    "mobile cash fields",
    '''                    <MobileField label="Expected">{money(collection.vms_expected_cash)}</MobileField>
                    <MobileField label="Counted">{money(collection.actual_cash_collected)}</MobileField>
                    <MobileField label="Variance"><span className={varianceClassName(variance)}>{money(variance)}</span></MobileField>''',
    '''                    <MobileField label="Counted">{money(collection.actual_cash_collected)}</MobileField>
                    <MobileField label="Counted at">{formatDate(collection.counted_at)}</MobileField>
                    <MobileField label="Monthly close"><Link href="/finance/operations" className="link-secondary">Reconcile by month</Link></MobileField>''',
)
cash_list = replace_once(
    cash_list,
    "cash table headers",
    '<DataTable className="hidden md:block" headers={["Machine", "Route", "Collected by", "Collected date", "Expected cash", "Counted amount", "Variance", "Status", "Finance", "Actions"]}>',
    '<DataTable className="hidden md:block" headers={["Machine", "Route", "Collected by", "Cash removed", "Counted amount", "Counted at", "Status", "Finance", "Actions"]}>',
)
cash_list = replace_once(
    cash_list,
    "cash table cells",
    '''                  <td>{formatDate(collection.collected_at)}</td>
                  <td>{money(collection.vms_expected_cash)}</td>
                  <td>{money(collection.actual_cash_collected)}</td>
                  <td className={varianceClassName(variance)}>{money(variance)}</td>''',
    '''                  <td>{formatDate(collection.collected_at)}</td>
                  <td>{money(collection.actual_cash_collected)}</td>
                  <td>{formatDate(collection.counted_at)}</td>''',
)
write("src/app/cash-collections/page.tsx", cash_list)


# Finance Operations: monthly close calculation and presentation.
finance_ops = read("src/app/finance/operations/page.tsx")
finance_ops = replace_once(
    finance_ops,
    "monthly close helper import",
    'import { formatMachineDisplayName } from "@/lib/machine-site-display";',
    '''import { formatMachineDisplayName } from "@/lib/machine-site-display";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "@/lib/monthly-cash-close";''',
)
finance_ops = replace_regex_once(
    finance_ops,
    "machine status helper",
    r"function statusForMachine\([\s\S]*?\n}\n\nfunction StatCard",
    '''function statusForMachine(row: {
  collectionCount: number;
  monthlyExpectedCash: number | null;
  monthlyVariance: number | null;
  vmsSalesAmount: number;
}, closedMonth: boolean) {
  if (!closedMonth) return "provisional month";
  if (row.monthlyExpectedCash === null) return "cash split unavailable";
  if (row.collectionCount === 0 && row.vmsSalesAmount > 0) return "no cash counted";
  if (Math.abs(row.monthlyVariance ?? 0) >= 10) return "variance review";
  return "reconciled";
}

function StatCard''',
)
finance_ops = replace_once(
    finance_ops,
    "base machine rows",
    '''  const machineRows = buildMachineCashReconciliation({
    machines: machineIdentities,
    cashCollections: countedCashRows,
    vmsRows: vmsMachineRows,
  });''',
    '''  const baseMachineRows = buildMachineCashReconciliation({
    machines: machineIdentities,
    cashCollections: countedCashRows,
    vmsRows: vmsMachineRows,
  });''',
)
finance_ops = replace_once(
    finance_ops,
    "monthly close calculations",
    '''  const paymentSplitAvailable = Boolean(salesSummary.payment_method_available);
  const vmsCogs = nullableNumeric(salesSummary.cogs_amount);''',
    '''  const paymentSplitAvailable = Boolean(salesSummary.payment_method_available);
  const monthlyExpectation = resolveMonthlyCashExpectation({
    paymentSplitAvailable,
    vmsCashSales,
    vmsRevenue,
  });
  const monthlyClose = reconcileMonthlyCash(cashSummary.countedCash, monthlyExpectation);
  const closedMonth = isCompleteClosedMonthRange(period.start, period.end);
  const machineRows = baseMachineRows.map((row) => {
    const monthlyExpectedCash = monthlyMachineExpectedCash({ paymentSplitAvailable, vmsSalesAmount: row.vmsSalesAmount });
    const monthlyVariance = monthlyExpectedCash === null ? null : row.countedCash - monthlyExpectedCash;
    return {
      ...row,
      monthlyExpectedCash,
      monthlyVariance,
      monthlyAccuracy: monthlyExpectedCash && monthlyExpectedCash > 0 ? row.countedCash / monthlyExpectedCash : null,
    };
  });
  const vmsCogs = nullableNumeric(salesSummary.cogs_amount);''',
)
finance_ops = re.sub(r"\n  const periodCashVsVmsCash = paymentSplitAvailable \? cashSummary\.countedCash - vmsCashSales : null;", "", finance_ops, count=1)
finance_ops = replace_once(
    finance_ops,
    "cash control copy",
    '          <p className="mt-1 text-sm text-slate-500">Counted cash is the physical amount entered by finance/admin. Recorded expected cash is the VMS expectation saved on each collection.</p>',
    '          <p className="mt-1 text-sm text-slate-500">Every pickup records only physical counted cash. Expected cash, shortage/overage, and accuracy are calculated for the complete selected month.</p>',
)
finance_ops = replace_once(
    finance_ops,
    "cash control cards",
    '''          <StatCard label="Actual counted cash" value={formatFinanceMoney(cashSummary.countedCash, "LYD")} note={`${cashSummary.countedRows.length} counted collection(s)`} tone="strong" />
          <StatCard label="Recorded VMS expected cash" value={formatFinanceMoney(cashSummary.expectedCash, "LYD")} note={`${cashSummary.missingExpectedCount} count(s) missing expected cash`} tone={cashSummary.missingExpectedCount ? "warn" : "default"} />
          <StatCard label="Cash variance" value={formatFinanceMoney(cashSummary.calculatedVariance, "LYD")} note="Counted minus recorded expected cash" tone={cashSummary.calculatedVariance < 0 ? "negative" : cashSummary.calculatedVariance > 0 ? "warn" : "positive"} />
          <StatCard label="Collection accuracy" value={percent(cashSummary.collectionAccuracy)} note={`${cashSummary.varianceReviewCount} collection(s) need variance review`} tone={cashSummary.varianceReviewCount ? "warn" : "positive"} />''',
    '''          <StatCard label="Cash counted for selected month" value={formatFinanceMoney(monthlyClose.countedCash, "LYD")} note={`${cashSummary.countedRows.length} pickup(s) added together`} tone="strong" />
          <StatCard label="Monthly VMS expected cash" value={monthlyClose.expectedCash === null ? "Not available" : formatFinanceMoney(monthlyClose.expectedCash, "LYD")} note={monthlyExpectation.note} tone={monthlyClose.expectedCash === null ? "warn" : "default"} />
          <StatCard label="Monthly shortage / overage" value={monthlyClose.variance === null ? "Not available" : formatFinanceMoney(monthlyClose.variance, "LYD")} note="Total counted cash minus monthly expected cash" tone={monthlyClose.variance === null ? "warn" : monthlyClose.variance < 0 ? "negative" : monthlyClose.variance > 0 ? "warn" : "positive"} />
          <StatCard label="Monthly cash accuracy" value={percent(monthlyClose.accuracy)} note={closedMonth ? "Closed calendar month" : "Provisional until the month is fully closed and remaining cash is counted"} tone={!closedMonth ? "warn" : monthlyClose.variance !== null && Math.abs(monthlyClose.variance) >= 10 ? "warn" : "positive"} />''',
)
finance_ops = replace_once(
    finance_ops,
    "payment split cards",
    '''          <StatCard label="VMS payment split" value={paymentSplitAvailable ? `${formatFinanceMoney(vmsCashSales, "LYD")} cash` : "Unavailable"} note={paymentSplitAvailable ? `${formatFinanceMoney(vmsCardSales, "LYD")} card • ${formatFinanceMoney(vmsUnknownSales, "LYD")} unknown` : "This source does not separate cash and card sales."} />
          {paymentSplitAvailable ? <StatCard label="Period cash vs VMS cash" value={formatFinanceMoney(periodCashVsVmsCash ?? 0, "LYD")} note="Counted during the period minus VMS cash sales dated in the period; timing differences can exist." tone={(periodCashVsVmsCash ?? 0) < 0 ? "warn" : "default"} /> : null}''',
    '''          <StatCard label="VMS payment split" value={paymentSplitAvailable ? `${formatFinanceMoney(vmsCashSales, "LYD")} cash` : "Cash-only assumption"} note={paymentSplitAvailable ? `${formatFinanceMoney(vmsCardSales, "LYD")} card • ${formatFinanceMoney(vmsUnknownSales, "LYD")} unknown` : "The report has no payment split, so monthly total sales are treated as expected cash for Snacky's current cash-only machines."} />''',
)
finance_ops = replace_once(
    finance_ops,
    "machine reconciliation copy",
    '          <p className="mt-1 text-sm leading-6 text-slate-500">Variance uses the expected cash saved on collection records. VMS sales is shown as full machine revenue for the selected sales dates and may include card sales.</p>',
    '          <p className="mt-1 text-sm leading-6 text-slate-500">All pickups counted during the selected month are added per machine. When VMS has no payment split, total machine sales are used as expected cash under the cash-only workflow. Current-month results remain provisional until the final month-end cash is removed and counted.</p>',
)
finance_ops = replace_once(
    finance_ops,
    "machine table headers",
    '              headers={["Machine", "Location", "VMS sales", "Units sold", "Expected cash", "Counted cash", "Variance", "Accuracy", "Collections", "Latest count", "Status"]}',
    '              headers={["Machine", "Location", "VMS sales", "Units sold", "Monthly expected cash", "Cash counted in month", "Monthly variance", "Monthly accuracy", "Pickups", "Latest count", "Status"]}',
)
finance_ops = replace_once(
    finance_ops,
    "machine table values",
    '''                  <td>{formatFinanceMoney(row.expectedCash, "LYD")}</td>
                  <td>{formatFinanceMoney(row.countedCash, "LYD")}</td>
                  <td className={row.calculatedVariance < 0 ? "font-semibold text-rose-700" : row.calculatedVariance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{formatFinanceMoney(row.calculatedVariance, "LYD")}</td>
                  <td>{percent(row.collectionAccuracy)}</td>
                  <td>{row.collectionCount}</td>
                  <td>{formatDateTime(row.latestCountedAt)}</td>
                  <td><StatusBadge status={statusForMachine(row)} /></td>''',
    '''                  <td>{row.monthlyExpectedCash === null ? "Not available" : formatFinanceMoney(row.monthlyExpectedCash, "LYD")}</td>
                  <td>{formatFinanceMoney(row.countedCash, "LYD")}</td>
                  <td className={row.monthlyVariance === null ? "text-slate-500" : row.monthlyVariance < 0 ? "font-semibold text-rose-700" : row.monthlyVariance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{row.monthlyVariance === null ? "Not available" : formatFinanceMoney(row.monthlyVariance, "LYD")}</td>
                  <td>{percent(row.monthlyAccuracy)}</td>
                  <td>{row.collectionCount}</td>
                  <td>{formatDateTime(row.latestCountedAt)}</td>
                  <td><StatusBadge status={statusForMachine(row, closedMonth)} /></td>''',
)
write("src/app/finance/operations/page.tsx", finance_ops)

print("Applied monthly cash close workflow.")
