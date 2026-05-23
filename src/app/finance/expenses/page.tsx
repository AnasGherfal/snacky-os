import { FilteredFinancePage } from "@/app/finance/_components/FilteredFinancePage";
import type { SearchParamsRecord } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export default async function FinanceExpensesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  return FilteredFinancePage({
    title: "Expenses",
    subtitle: "Active money-out transactions from the finance ledger.",
    breadcrumbLabel: "Expenses",
    emptyTitle: "No expenses found",
    emptyBody: "Money-out transactions will appear here after they are imported or entered manually.",
    basePath: "/finance/expenses",
    searchParams: await searchParams,
    applyQuery: (query) => query.eq("direction", "money_out"),
    filter: (row) => row.direction === "money_out",
  });
}
