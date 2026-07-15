import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const salesPagePath = path.join(repoRoot, "src/app/sales/page.tsx");
let source = fs.readFileSync(salesPagePath, "utf8");

function replaceOnce(label, before, after) {
  const occurrences = source.split(before).length - 1;
  if (occurrences === 0 && source.includes(after)) return;
  if (occurrences !== 1) throw new Error(`${label}: expected exactly one match, found ${occurrences}`);
  source = source.replace(before, after);
}

function replaceRegexOnce(label, pattern, after) {
  const matches = source.match(pattern) ?? [];
  if (!matches.length && source.includes(after)) return;
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one regex match, found ${matches.length}`);
  source = source.replace(pattern, after);
}

function replaceTable(label, startMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    if (source.includes(replacement)) return;
    throw new Error(`${label}: start marker was not found`);
  }
  const end = source.indexOf("</DataTable>", start);
  if (end < 0) throw new Error(`${label}: closing DataTable was not found`);
  source = `${source.slice(0, start)}${replacement}${source.slice(end + "</DataTable>".length)}`;
}

replaceRegexOnce(
  "all product sales rows",
  /  const topProductSalesRows = \[\.\.\.productBreakdownRows\]\s*\.sort\(\(left, right\) => right\.successfulSalesAmount - left\.successfulSalesAmount \|\| right\.unitsSold - left\.unitsSold \|\| left\.bucketLabel\.localeCompare\(right\.bucketLabel\)\)\s*\.slice\(0, 15\);/,
  `  const productSalesRows = [...productBreakdownRows]\n    .sort((left, right) => right.successfulSalesAmount - left.successfulSalesAmount || right.unitsSold - left.unitsSold || left.bucketLabel.localeCompare(right.bucketLabel));`,
);
source = source.replaceAll("topProductSalesRows", "productSalesRows");

const unitsCard = `              <MetricCard label={t("Units Sold")} value={<MetricValue>{formatInteger(summary.successfulUnitsSold)}</MetricValue>} />`;
if (!source.includes('label="Revenue / Unit"')) {
  replaceOnce(
    "detailed sales metrics",
    unitsCard,
    `${unitsCard}\n              <MetricCard label="Successful Sales" value={<MetricValue>{formatInteger(summary.successfulSalesCount)}</MetricValue>} helper="Completed sales transactions in the selected range." />\n              <MetricCard label="Revenue / Unit" value={<MetricValue>{summary.successfulUnitsSold > 0 ? lyd(summary.revenueAmount / summary.successfulUnitsSold) : "0 LYD"}</MetricValue>} helper="Average revenue earned per unit sold." />\n              <MetricCard label="Total Attempts" value={<MetricValue>{formatInteger(summary.totalAttemptCount)}</MetricValue>} helper="Successful sales plus failed, refunded, and other transaction attempts." />\n              <MetricCard label="Failed Vend Rate" tone={summary.failedVendRate > 0.03 ? "warn" : "default"} value={<MetricValue>{formatMarginPercent(summary.failedVendRate)}</MetricValue>} />\n              <MetricCard label="Failed Vends" tone={summary.failedVendCount > 0 ? "warn" : "default"} value={<MetricValue>{formatInteger(summary.failedVendCount)}</MetricValue>} />\n              <MetricCard label="Refunds" tone={summary.refundCount > 0 ? "warn" : "default"} value={<MetricValue>{formatInteger(summary.refundCount)}</MetricValue>} />\n              <MetricCard label="Failed Payments" tone={summary.failedPaymentCount > 0 ? "warn" : "default"} value={<MetricValue>{formatInteger(summary.failedPaymentCount)}</MetricValue>} />\n              <MetricCard label="Needs Review" tone={summary.needsReviewCount > 0 ? "warn" : "default"} value={<MetricValue>{formatInteger(summary.needsReviewCount)}</MetricValue>} />\n              {canViewProfit ? (\n                <MetricCard\n                  label="Profit / Unit"\n                  value={<MetricValue>{summary.grossProfitAmount === null || summary.successfulUnitsSold <= 0 ? "Not available" : lyd(summary.grossProfitAmount / summary.successfulUnitsSold)}</MetricValue>}\n                  helper="Gross profit divided by units sold."\n                />\n              ) : null}`,
  );
}

replaceOnce(
  "sales product section subtitle",
  `<KpiSection title={t("Sales by product")} subtitle={t("Top products ranked by revenue.")}>`,
  `<KpiSection title={t("Sales by product")} subtitle={t("All products are shown. Sort by units sold, successful sales, revenue, revenue per unit, or product name.")}>`,
);

const salesTableReplacement = `<DataTable headers={[t("Product"), t("Units sold"), t("Successful sales"), t("Revenue"), t("Revenue / unit")]}>\n                  {productSalesRows.map((row) => (\n                    <tr key={row.bucketLabel}>\n                      <td className="font-medium">{row.bucketLabel}</td>\n                      <td>{formatInteger(row.unitsSold)}</td>\n                      <td>{formatInteger(row.successfulSalesCount)}</td>\n                      <td>{lyd(row.successfulSalesAmount)}</td>\n                      <td>{row.unitsSold > 0 ? lyd(row.successfulSalesAmount / row.unitsSold) : "0 LYD"}</td>\n                    </tr>\n                  ))}\n                </DataTable>`;
if (!source.includes('t("Revenue / unit")') || source.includes('headers={[t("Product"), t("Units sold"), t("Revenue")]}')) {
  replaceTable(
    "sales product table",
    `<DataTable headers={[t("Product"), t("Units sold"), t("Revenue")]}>`,
    salesTableReplacement,
  );
}

replaceOnce(
  "product profit section subtitle",
  `<KpiSection title={t("Product profit")} subtitle={t(profitSectionSubtitle, profitSectionSubtitle)}>`,
  `<KpiSection title={t("Product profit")} subtitle={t(profitSectionSubtitle + " All products are shown and can be sorted by profit, units, revenue, cost, margin, or name.", profitSectionSubtitle + " All products are shown and can be sorted by profit, units, revenue, cost, margin, or name.")}>`,
);

const profitTableReplacement = `<DataTable headers={[t("Product"), t("Units sold"), t("Successful sales"), t("Revenue"), t("Revenue / unit"), t("Cost"), t("Gross profit"), t("Profit / unit"), t("Margin %"), t("Cost status")]}>\n                    {productProfitRows.map((row) => (\n                      <tr key={row.bucketKey}>\n                        <td className="font-medium">{row.bucketLabel}</td>\n                        <td>{formatInteger(row.unitsSold)}</td>\n                        <td>{formatInteger(row.successfulSalesCount)}</td>\n                        <td>{lyd(row.revenueAmount)}</td>\n                        <td>{row.unitsSold > 0 ? lyd(row.revenueAmount / row.unitsSold) : "0 LYD"}</td>\n                        <td>{lyd(row.cogsAmount)}</td>\n                        <td>{lyd(row.grossProfitAmount)}</td>\n                        <td>{row.unitsSold > 0 ? lyd(row.grossProfitAmount / row.unitsSold) : "0 LYD"}</td>\n                        <td>{formatMarginPercent(row.grossMarginPercent)}</td>\n                        <td><StatusBadge status={compactStatusLabel(row.costStatus)} /></td>\n                      </tr>\n                    ))}\n                  </DataTable>`;
if (source.includes("productProfitRows.slice(0, 20)")) {
  replaceTable(
    "product profit table",
    `<DataTable headers={[t("Product"), t("Units sold"), t("Revenue"), t("Cost"), t("Gross profit"), t("Margin %"), t("Cost status")]}>`,
    profitTableReplacement,
  );
}

if (source.includes("productProfitRows.slice(0, 20)") || source.includes("const topProductSalesRows") || source.includes(".slice(0, 15);")) {
  throw new Error("Product ranking limits are still present after the codemod.");
}

fs.writeFileSync(salesPagePath, source);
console.log("Sales dashboard product ranking and detailed metrics applied.");
