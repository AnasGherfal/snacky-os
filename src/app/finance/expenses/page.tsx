import { FilteredFinancePage } from "@/app/finance/_components/FilteredFinancePage";

export const dynamic = "force-dynamic";

export default async function FinanceExpensesPage() {
  return FilteredFinancePage({
    title: "Expenses",
    subtitle: "Active money-out transactions from the finance ledger.",
    breadcrumbLabel: "Expenses",
    emptyTitle: "No expenses found",
    emptyBody: "Money-out transactions will appear here after they are imported or entered manually.",
    filter: (row) => row.direction === "money_out",
  });
}
