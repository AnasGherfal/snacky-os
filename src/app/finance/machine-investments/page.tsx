import { FilteredFinancePage, financeRowText } from "@/app/finance/_components/FilteredFinancePage";

export const dynamic = "force-dynamic";

export default async function FinanceMachineInvestmentsPage() {
  return FilteredFinancePage({
    title: "Machine Investments",
    subtitle: "Machine, equipment, and asset investment transactions from the finance ledger.",
    breadcrumbLabel: "Machine Investments",
    emptyTitle: "No machine investments found",
    emptyBody: "Machine investment transactions will appear here when their ledger text references machine purchases, equipment, or assets.",
    filter: (row) => {
      const text = financeRowText(row);
      return text.includes("machine investment") || text.includes("machine purchase") || text.includes("equipment") || text.includes("asset");
    },
  });
}
