import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function write(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), value);
}

function replaceOnce(source, label, before, after) {
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return source;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
}

function replaceRegexOnce(source, label, pattern, after) {
  const matches = source.match(pattern) ?? [];
  if (matches.length === 0 && source.includes(after)) return source;
  if (matches.length !== 1) throw new Error(`${label}: expected one regex match, found ${matches.length}`);
  return source.replace(pattern, after);
}

// ---------------------------------------------------------------------------
// Cash actions: collections store counted money only. Expected cash is monthly.
// ---------------------------------------------------------------------------
let cashActions = read("src/lib/cash-actions.ts");
cashActions = replaceOnce(
  cashActions,
  "create expected cash",
  `  const expectedCash = optionalAmount(formData.get("expected_cash_lyd"));`,
  `  const expectedCash = null;`,
);
cashActions = replaceOnce(
  cashActions,
  "confirm expected cash",
  `  const expectedFromForm = optionalAmount(formData.get("expected_cash_lyd"));\n  const expectedCash = expectedFromForm ?? (before.vms_expected_cash === null || before.vms_expected_cash === undefined ? null : Number(before.vms_expected_cash));`,
  `  const expectedCash = null;`,
);
cashActions = replaceOnce(
  cashActions,
  "update expected cash",
  `  const expectedCash = optionalAmount(formData.get("expected_cash_lyd"));`,
  `  const expectedCash = null;`,
);
write("src/lib/cash-actions.ts", cashActions);

// ---------------------------------------------------------------------------
// Cash collection list: remove misleading per-pickup expected/variance columns.
// ---------------------------------------------------------------------------
let cashList = read("src/app/cash-collections/page.tsx");
cashList = replaceOnce(
  cashList,
  "cash variance imports",
  `import { getCashCollectionStatus, isCriticalCashVariance, isLargeCashVariance } from "@/lib/cash-collections";`,
  `import { getCashCollectionStatus } from "@/lib/cash-collections";`,
);
cashList = replaceRegexOnce(
  cashList,
  "variance class helper",
  /\nfunction varianceClassName\([\s\S]*?\n}\n\nexport default async function CashCollectionsPage/,
  `\nexport default async function CashCollectionsPage`,
);
cashList = cashList.replace(/\n  const totalExpected = activeRows\.reduce\([^\n]+\);/, "");
cashList = cashList.replace(/\n  const reviewCount = rows\.filter\([^\n]+\);/, "");
cashList = replaceOnce(
  cashList,
  "cash list subtitle",
  `        subtitle="Track route cash pickup, finance counting, variances, and linked money-in transactions."`,
  `        subtitle="Record every physical cash pickup and counted amount. Expected cash and shortage/overage are reconciled for the full machine month in Finance Operations."`,
);
cashList = replaceOnce(
  cashList,
  "cash list cards",
  `          <div className="grid gap-4 sm:grid-cols-4">\n            <SectionCard><div className="text-sm text-slate-500">Expected cash</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalExpected)}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalCounted)}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Pending count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{pendingCount}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Variance review</div><div className="mt-2 text-2xl font-semibold text-slate-900">{reviewCount}</div></SectionCard>\n          </div>`,
  `          <div className="grid gap-4 sm:grid-cols-4">\n            <SectionCard><div className="text-sm text-slate-500">Counted amount</div><div className="mt-2 text-2xl font-semibold text-slate-900">{lyd(totalCounted)}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Collections on this page</div><div className="mt-2 text-2xl font-semibold text-slate-900">{activeRows.length}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Pending count</div><div className="mt-2 text-2xl font-semibold text-slate-900">{pendingCount}</div></SectionCard>\n            <SectionCard><div className="text-sm text-slate-500">Monthly close</div><div className="mt-3"><Link href="/finance/operations" className="link-secondary">Open reconciliation</Link></div></SectionCard>\n          </div>`,
);
cashList = replaceOnce(
  cashList,
  "mobile cash fields",
  `                    <MobileField label="Expected">{money(collection.vms_expected_cash)}</MobileField>\n                    <MobileField label="Counted">{money(collection.actual_cash_collected)}</MobileField>\n                    <MobileField label="Variance"><span className={varianceClassName(variance)}>{money(variance)}</span></MobileField>`,
  `                    <MobileField label="Counted">{money(collection.actual_cash_collected)}</MobileField>\n                    <MobileField label="Counted at">{formatDate(collection.counted_at)}</MobileField>\n                    <MobileField label="Monthly close"><Link href="/finance/operations" className="link-secondary">Reconcile by month</Link></MobileField>`,
);
cashList = replaceOnce(
  cashList,
  "cash table headers",
  `<DataTable className="hidden md:block" headers={["Machine", "Route", "Collected by", "Collected date", "Expected cash", "Counted amount", "Variance", "Status", "Finance", "Actions"]}>`,
  `<DataTable className="hidden md:block" headers={["Machine", "Route", "Collected by", "Cash removed", "Counted amount", "Counted at", "Status", "Finance", "Actions"]}>`,
);
cashList = replaceOnce(
  cashList,
  "cash table cells",
  `                  <td>{formatDate(collection.collected_at)}</td>\n                  <td>{money(collection.vms_expected_cash)}</td>\n                  <td>{money(collection.actual_cash_collected)}</td>\n                  <td className={varianceClassName(variance)}>{money(variance)}</td>`,
  `                  <td>{formatDate(collection.collected_at)}</td>\n                  <td>{money(collection.actual_cash_collected)}</td>\n                  <td>{formatDate(collection.counted_at)}</td>`,
);
write("src/app/cash-collections/page.tsx", cashList);

// ---------------------------------------------------------------------------
// Finance Operations: monthly close, not per-pickup expectation.
// ---------------------------------------------------------------------------
let financeOps = read("src/app/finance/operations/page.tsx");
financeOps = replaceOnce(
  financeOps,
  "monthly close helper import",
  `import { formatMachineDisplayName } from "@/lib/machine-site-display";`,
  `import { formatMachineDisplayName } from "@/lib/machine-site-display";\nimport {\n  isCompleteClosedMonthRange,\n  monthlyMachineExpectedCash,\n  reconcileMonthlyCash,\n  resolveMonthlyCashExpectation,\n} from "@/lib/monthly-cash-close";`,
);
financeOps = replaceRegexOnce(
  financeOps,
  "machine status helper",
  /function statusForMachine\([\s\S]*?\n}\n\nfunction StatCard/,
  `function statusForMachine(row: {\n  collectionCount: number;\n  monthlyExpectedCash: number | null;\n  monthlyVariance: number | null;\n  vmsSalesAmount: number;\n}, closedMonth: boolean) {\n  if (!closedMonth) return "provisional month";\n  if (row.monthlyExpectedCash === null) return "cash split unavailable";\n  if (row.collectionCount === 0 && row.vmsSalesAmount > 0) return "no cash counted";\n  if (Math.abs(row.monthlyVariance ?? 0) >= 10) return "variance review";\n  return "reconciled";\n}\n\nfunction StatCard`,
);
financeOps = replaceOnce(
  financeOps,
  "base machine rows",
  `  const machineRows = buildMachineCashReconciliation({\n    machines: machineIdentities,\n    cashCollections: countedCashRows,\n    vmsRows: vmsMachineRows,\n  });`,
  `  const baseMachineRows = buildMachineCashReconciliation({\n    machines: machineIdentities,\n    cashCollections: countedCashRows,\n    vmsRows: vmsMachineRows,\n  });`,
);
financeOps = replaceOnce(
  financeOps,
  "monthly close calculations",
  `  const paymentSplitAvailable = Boolean(salesSummary.payment_method_available);\n  const vmsCogs = nullableNumeric(salesSummary.cogs_amount);`,
  `  const paymentSplitAvailable = Boolean(salesSummary.payment_method_available);\n  const monthlyExpectation = resolveMonthlyCashExpectation({\n    paymentSplitAvailable,\n    vmsCashSales,\n    vmsRevenue,\n  });\n  const monthlyClose = reconcileMonthlyCash(cashSummary.countedCash, monthlyExpectation);\n  const closedMonth = isCompleteClosedMonthRange(period.start, period.end);\n  const machineRows = baseMachineRows.map((row) => {\n    const monthlyExpectedCash = monthlyMachineExpectedCash({ paymentSplitAvailable, vmsSalesAmount: row.vmsSalesAmount });\n    const monthlyVariance = monthlyExpectedCash === null ? null : row.countedCash - monthlyExpectedCash;\n    return {\n      ...row,\n      monthlyExpectedCash,\n      monthlyVariance,\n      monthlyAccuracy: monthlyExpectedCash && monthlyExpectedCash > 0 ? row.countedCash / monthlyExpectedCash : null,\n    };\n  });\n  const vmsCogs = nullableNumeric(salesSummary.cogs_amount);`,
);
financeOps = financeOps.replace(/\n  const periodCashVsVmsCash = paymentSplitAvailable \? cashSummary\.countedCash - vmsCashSales : null;/, "");
financeOps = replaceOnce(
  financeOps,
  "cash control copy",
  `          <p className="mt-1 text-sm text-slate-500">Counted cash is the physical amount entered by finance/admin. Recorded expected cash is the VMS expectation saved on each collection.</p>`,
  `          <p className="mt-1 text-sm text-slate-500">Every pickup records only physical counted cash. Expected cash, shortage/overage, and accuracy are calculated for the complete selected month.</p>`,
);
financeOps = replaceOnce(
  financeOps,
  "cash control cards",
  `          <StatCard label="Actual counted cash" value={formatFinanceMoney(cashSummary.countedCash, "LYD")} note={\`${cashSummary.countedRows.length} counted collection(s)\`} tone="strong" />\n          <StatCard label="Recorded VMS expected cash" value={formatFinanceMoney(cashSummary.expectedCash, "LYD")} note={\`${cashSummary.missingExpectedCount} count(s) missing expected cash\`} tone={cashSummary.missingExpectedCount ? "warn" : "default"} />\n          <StatCard label="Cash variance" value={formatFinanceMoney(cashSummary.calculatedVariance, "LYD")} note="Counted minus recorded expected cash" tone={cashSummary.calculatedVariance < 0 ? "negative" : cashSummary.calculatedVariance > 0 ? "warn" : "positive"} />\n          <StatCard label="Collection accuracy" value={percent(cashSummary.collectionAccuracy)} note={\`${cashSummary.varianceReviewCount} collection(s) need variance review\`} tone={cashSummary.varianceReviewCount ? "warn" : "positive"} />`,
  `          <StatCard label="Cash counted for selected month" value={formatFinanceMoney(monthlyClose.countedCash, "LYD")} note={\`${cashSummary.countedRows.length} pickup(s) added together\`} tone="strong" />\n          <StatCard label="Monthly VMS expected cash" value={monthlyClose.expectedCash === null ? "Not available" : formatFinanceMoney(monthlyClose.expectedCash, "LYD")} note={monthlyExpectation.note} tone={monthlyClose.expectedCash === null ? "warn" : "default"} />\n          <StatCard label="Monthly shortage / overage" value={monthlyClose.variance === null ? "Not available" : formatFinanceMoney(monthlyClose.variance, "LYD")} note="Total counted cash minus monthly expected cash" tone={monthlyClose.variance === null ? "warn" : monthlyClose.variance < 0 ? "negative" : monthlyClose.variance > 0 ? "warn" : "positive"} />\n          <StatCard label="Monthly cash accuracy" value={percent(monthlyClose.accuracy)} note={closedMonth ? "Closed calendar month" : "Provisional until the month is fully closed and remaining cash is counted"} tone={!closedMonth ? "warn" : monthlyClose.variance !== null && Math.abs(monthlyClose.variance) >= 10 ? "warn" : "positive"} />`,
);
financeOps = replaceOnce(
  financeOps,
  "payment split cards",
  `          <StatCard label="VMS payment split" value={paymentSplitAvailable ? \`${formatFinanceMoney(vmsCashSales, "LYD")} cash\` : "Unavailable"} note={paymentSplitAvailable ? \`${formatFinanceMoney(vmsCardSales, "LYD")} card • ${formatFinanceMoney(vmsUnknownSales, "LYD")} unknown\` : "This source does not separate cash and card sales."} />\n          {paymentSplitAvailable ? <StatCard label="Period cash vs VMS cash" value={formatFinanceMoney(periodCashVsVmsCash ?? 0, "LYD")} note="Counted during the period minus VMS cash sales dated in the period; timing differences can exist." tone={(periodCashVsVmsCash ?? 0) < 0 ? "warn" : "default"} /> : null}`,
  `          <StatCard label="VMS payment split" value={paymentSplitAvailable ? \`${formatFinanceMoney(vmsCashSales, "LYD")} cash\` : "Cash-only assumption"} note={paymentSplitAvailable ? \`${formatFinanceMoney(vmsCardSales, "LYD")} card • ${formatFinanceMoney(vmsUnknownSales, "LYD")} unknown\` : "The report has no payment split, so monthly total sales are treated as expected cash for Snacky's current cash-only machines."} />`,
);
financeOps = replaceOnce(
  financeOps,
  "machine reconciliation copy",
  `          <p className="mt-1 text-sm leading-6 text-slate-500">Variance uses the expected cash saved on collection records. VMS sales is shown as full machine revenue for the selected sales dates and may include card sales.</p>`,
  `          <p className="mt-1 text-sm leading-6 text-slate-500">All pickups counted during the selected month are added per machine. When VMS has no payment split, total machine sales are used as expected cash under the cash-only workflow. Current-month results remain provisional until the final month-end cash is removed and counted.</p>`,
);
financeOps = replaceOnce(
  financeOps,
  "machine table headers",
  `              headers={["Machine", "Location", "VMS sales", "Units sold", "Expected cash", "Counted cash", "Variance", "Accuracy", "Collections", "Latest count", "Status"]}`,
  `              headers={["Machine", "Location", "VMS sales", "Units sold", "Monthly expected cash", "Cash counted in month", "Monthly variance", "Monthly accuracy", "Pickups", "Latest count", "Status"]}`,
);
financeOps = replaceOnce(
  financeOps,
  "machine table values",
  `                  <td>{formatFinanceMoney(row.expectedCash, "LYD")}</td>\n                  <td>{formatFinanceMoney(row.countedCash, "LYD")}</td>\n                  <td className={row.calculatedVariance < 0 ? "font-semibold text-rose-700" : row.calculatedVariance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{formatFinanceMoney(row.calculatedVariance, "LYD")}</td>\n                  <td>{percent(row.collectionAccuracy)}</td>\n                  <td>{row.collectionCount}</td>\n                  <td>{formatDateTime(row.latestCountedAt)}</td>\n                  <td><StatusBadge status={statusForMachine(row)} /></td>`,
  `                  <td>{row.monthlyExpectedCash === null ? "Not available" : formatFinanceMoney(row.monthlyExpectedCash, "LYD")}</td>\n                  <td>{formatFinanceMoney(row.countedCash, "LYD")}</td>\n                  <td className={row.monthlyVariance === null ? "text-slate-500" : row.monthlyVariance < 0 ? "font-semibold text-rose-700" : row.monthlyVariance > 0 ? "font-semibold text-amber-700" : "font-medium text-emerald-700"}>{row.monthlyVariance === null ? "Not available" : formatFinanceMoney(row.monthlyVariance, "LYD")}</td>\n                  <td>{percent(row.monthlyAccuracy)}</td>\n                  <td>{row.collectionCount}</td>\n                  <td>{formatDateTime(row.latestCountedAt)}</td>\n                  <td><StatusBadge status={statusForMachine(row, closedMonth)} /></td>`,
);
write("src/app/finance/operations/page.tsx", financeOps);

console.log("Applied monthly cash close workflow.");
