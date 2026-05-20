import { FilteredFinancePage, financeRowText } from "@/app/finance/_components/FilteredFinancePage";

export const dynamic = "force-dynamic";

export default async function FinanceRentPage() {
  return FilteredFinancePage({
    title: "Rent",
    subtitle: "Rent-labelled active transactions from the finance ledger.",
    breadcrumbLabel: "Rent",
    emptyTitle: "No rent transactions found",
    emptyBody: "Rent transactions will appear here when their category, bucket, or description includes rent.",
    filter: (row) => financeRowText(row).includes("rent"),
  });
}
