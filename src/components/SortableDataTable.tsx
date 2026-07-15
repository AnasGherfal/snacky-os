"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  compareSortableCellText,
  defaultSortDirectionForHeader,
  summarizeTableColumns,
  type TableSortDirection,
  type TableSummaryMetric,
} from "@/lib/table-sort";

type SortableDataTableProps = {
  headers: string[];
  children: ReactNode;
  className?: string;
  sortable?: boolean;
  showSummary?: boolean;
};

function isSortableHeader(header: string) {
  return !/^action$/i.test(header.trim());
}

export function SortableDataTable({
  headers,
  children,
  className = "",
  sortable,
  showSummary,
}: SortableDataTableProps) {
  const pathname = usePathname();
  const enhancedForSales = pathname === "/sales" || pathname?.startsWith("/sales?");
  const sortingEnabled = sortable ?? enhancedForSales;
  const summaryEnabled = showSummary ?? enhancedForSales;
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const originalOrderRef = useRef<Map<HTMLTableRowElement, number>>(new Map());
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [direction, setDirection] = useState<TableSortDirection>("desc");
  const [query, setQuery] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [visibleRowCount, setVisibleRowCount] = useState(0);
  const [summaryMetrics, setSummaryMetrics] = useState<TableSummaryMetric[]>([]);
  const headersKey = headers.join("\u001f");

  const sortableColumns = useMemo(
    () => headers.map((header, index) => ({ header, index })).filter(({ header }) => isSortableHeader(header)),
    [headersKey],
  );

  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody) return;

    const rows = Array.from(tbody.rows);
    const originalOrder = new Map<HTMLTableRowElement, number>();
    rows.forEach((row, index) => {
      originalOrder.set(row, index);
      row.dataset.originalTableOrder = String(index);
    });
    originalOrderRef.current = originalOrder;
    setRowCount(rows.length);
    setVisibleRowCount(rows.length);

    if (summaryEnabled) {
      const textRows = rows.map((row) => Array.from(row.cells).map((cell) => cell.innerText.trim()));
      setSummaryMetrics(summarizeTableColumns(headers, textRows));
    } else {
      setSummaryMetrics([]);
    }
  }, [headersKey, summaryEnabled]);

  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody) return;

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const rows = Array.from(tbody.rows);
    rows.forEach((row) => {
      row.hidden = Boolean(normalizedQuery) && !row.innerText.toLocaleLowerCase().includes(normalizedQuery);
    });

    const sortedRows = [...rows].sort((left, right) => {
      if (sortColumn === null) {
        return (originalOrderRef.current.get(left) ?? 0) - (originalOrderRef.current.get(right) ?? 0);
      }

      const leftText = left.cells.item(sortColumn)?.innerText ?? "";
      const rightText = right.cells.item(sortColumn)?.innerText ?? "";
      const comparison = compareSortableCellText(leftText, rightText, direction);
      return comparison || (originalOrderRef.current.get(left) ?? 0) - (originalOrderRef.current.get(right) ?? 0);
    });

    sortedRows.forEach((row) => tbody.appendChild(row));
    setVisibleRowCount(sortedRows.filter((row) => !row.hidden).length);
  }, [direction, query, rowCount, sortColumn]);

  function chooseSortColumn(nextColumn: number | null) {
    setSortColumn(nextColumn);
    if (nextColumn !== null) setDirection(defaultSortDirectionForHeader(headers[nextColumn] ?? ""));
  }

  function handleHeaderSort(columnIndex: number) {
    if (!sortingEnabled || !isSortableHeader(headers[columnIndex] ?? "")) return;
    if (sortColumn === columnIndex) {
      setDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    chooseSortColumn(columnIndex);
  }

  const activeSortLabel = sortColumn === null ? "Current dashboard order" : headers[sortColumn] ?? "Selected column";

  return (
    <div className={className}>
      {sortingEnabled && rowCount > 1 ? (
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_150px_minmax(180px,1fr)]">
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Sort by</span>
                <select
                  className="field-input h-10 w-full"
                  value={sortColumn === null ? "" : String(sortColumn)}
                  onChange={(event) => chooseSortColumn(event.target.value === "" ? null : Number(event.target.value))}
                >
                  <option value="">Current dashboard order</option>
                  {sortableColumns.map(({ header, index }) => <option key={`${header}-${index}`} value={index}>{header}</option>)}
                </select>
              </label>

              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Direction</span>
                <select
                  className="field-input h-10 w-full"
                  value={direction}
                  disabled={sortColumn === null}
                  onChange={(event) => setDirection(event.target.value as TableSortDirection)}
                >
                  <option value="desc">Highest first</option>
                  <option value="asc">Lowest first</option>
                </select>
              </label>

              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Filter rows</span>
                <input
                  className="field-input h-10 w-full"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Product, machine, location..."
                  type="search"
                />
              </label>
            </div>

            <div className="shrink-0 text-xs leading-5 text-slate-500">
              <div className="font-semibold text-slate-700">{activeSortLabel}</div>
              <div>{visibleRowCount === rowCount ? `${rowCount} rows` : `${visibleRowCount} of ${rowCount} rows`}</div>
              <div>Click a column heading to sort quickly.</div>
            </div>
          </div>
        </div>
      ) : null}

      {summaryEnabled && summaryMetrics.length ? (
        <div className="mb-3 flex flex-wrap gap-2" aria-label="Table totals and averages">
          {summaryMetrics.map((metric) => (
            <div key={`${metric.columnIndex}-${metric.label}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{metric.label}</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">{metric.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {headers.map((header, columnIndex) => {
                const canSort = sortingEnabled && isSortableHeader(header);
                const active = sortColumn === columnIndex;
                return (
                  <th
                    key={`${header}-${columnIndex}`}
                    aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="inline-flex w-full items-center justify-between gap-2 text-left font-semibold text-inherit hover:text-slate-950"
                        onClick={() => handleHeaderSort(columnIndex)}
                      >
                        <span>{header}</span>
                        <span className={active ? "text-slate-900" : "text-slate-300"} aria-hidden="true">
                          {active ? (direction === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    ) : header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
