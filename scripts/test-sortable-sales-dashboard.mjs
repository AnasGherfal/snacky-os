import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareSortableCellText,
  defaultSortDirectionForHeader,
  parseSortableCell,
  summarizeTableColumns,
} from "../src/lib/table-sort.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const salesPage = fs.readFileSync(path.join(repoRoot, "src/app/sales/page.tsx"), "utf8");
const sortableTable = fs.readFileSync(path.join(repoRoot, "src/components/SortableDataTable.tsx"), "utf8");

test("currency, percentages, and Arabic digits are parsed numerically", () => {
  assert.deepEqual(parseSortableCell("1,250 LYD"), { kind: "number", value: 1250 });
  assert.deepEqual(parseSortableCell("42.5%"), { kind: "number", value: 42.5 });
  assert.deepEqual(parseSortableCell("١٢٣"), { kind: "number", value: 123 });
});

test("numeric sorting supports highest-first and lowest-first ordering", () => {
  assert.ok(compareSortableCellText("1,250 LYD", "900 LYD", "desc") < 0);
  assert.ok(compareSortableCellText("1,250 LYD", "900 LYD", "asc") > 0);
  assert.equal(defaultSortDirectionForHeader("Gross profit"), "desc");
  assert.equal(defaultSortDirectionForHeader("Product"), "asc");
});

test("empty cells remain at the bottom in both directions", () => {
  assert.ok(compareSortableCellText("Not available", "12", "desc") > 0);
  assert.ok(compareSortableCellText("Not available", "12", "asc") > 0);
});

test("table summaries total financial columns and average margin columns", () => {
  const metrics = summarizeTableColumns(
    ["Product", "Units sold", "Revenue", "Gross profit", "Margin %"],
    [
      ["A", "10", "100 LYD", "40 LYD", "40.0%"],
      ["B", "20", "300 LYD", "90 LYD", "30.0%"],
    ],
  );
  const byLabel = new Map(metrics.map((metric) => [metric.label, metric.value]));
  assert.equal(byLabel.get("Units sold total"), "30");
  assert.equal(byLabel.get("Revenue total"), "400 LYD");
  assert.equal(byLabel.get("Gross profit total"), "130 LYD");
  assert.equal(byLabel.get("Margin % average"), "35.0%");
});

test("sales dashboard exposes every product and detailed ranking metrics", () => {
  assert.match(salesPage, /const productSalesRows = \[\.\.\.productBreakdownRows\]/);
  assert.doesNotMatch(salesPage, /const topProductSalesRows/);
  assert.doesNotMatch(salesPage, /productProfitRows\.slice\(0, 20\)/);
  assert.match(salesPage, /Successful Sales/);
  assert.match(salesPage, /Revenue \/ Unit/);
  assert.match(salesPage, /Profit \/ Unit/);
  assert.match(salesPage, /Failed Vend Rate/);
  assert.match(salesPage, /Failed Payments/);
  assert.match(salesPage, /Needs Review/);
  assert.match(salesPage, /t\("Successful sales"\)/);
  assert.match(salesPage, /t\("Gross profit"\)/);
});

test("sales tables provide explicit sort, direction, filter, and summary controls", () => {
  assert.match(sortableTable, /Sort by/);
  assert.match(sortableTable, /Highest first/);
  assert.match(sortableTable, /Lowest first/);
  assert.match(sortableTable, /Filter rows/);
  assert.match(sortableTable, /summarizeTableColumns/);
  assert.match(sortableTable, /Click a column heading to sort quickly/);
});
