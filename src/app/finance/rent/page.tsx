import {
  FilteredFinancePage,
  financeRowText,
} from "@/app/finance/_components/FilteredFinancePage";
import type { SearchParamsRecord } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export default async function FinanceRentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  return FilteredFinancePage({
    title: "Rent",
    subtitle: "Rent-labelled active transactions from the finance ledger.",
    breadcrumbLabel: "Rent",
    emptyTitle: "No rent transactions found",
    emptyBody:
      "Rent transactions will appear here when their category, bucket, or description includes rent.",
    basePath: "/finance/rent",
    searchParams: await searchParams,
    applyQuery: (query, level) => {
      const columns =
        level === "legacy"
          ? [
              "transaction_kind",
              "transaction_type",
              "description",
              "final_bucket",
            ]
          : [
              "transaction_kind",
              "transaction_type",
              "description",
              "notes",
              "final_bucket",
              "payment_method",
            ];
      return query.or(
        columns.map((column) => `${column}.ilike.%rent%`).join(","),
      );
    },
    filter: (row) => financeRowText(row).includes("rent"),
  });
}
