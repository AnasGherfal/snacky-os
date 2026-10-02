import { FilteredFinancePage, financeRowText } from "@/app/finance/_components/FilteredFinancePage";
import type { SearchParamsRecord } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const machineInvestmentTerms = ["machine investment", "machine purchase", "equipment", "asset"];
const searchableColumns = ["transaction_kind", "transaction_type", "description", "notes", "final_bucket", "payment_method"];

export default async function FinanceMachineInvestmentsPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  return FilteredFinancePage({
    title: "Machine Investments",
    subtitle: "Machine, equipment, and asset investment transactions from the finance ledger.",
    breadcrumbLabel: "Machine Investments",
    emptyTitle: "No machine investments found",
    emptyBody: "Machine investment transactions will appear here when their ledger text references machine purchases, equipment, or assets.",
    basePath: "/finance/machine-investments",
    searchParams: await searchParams,
    applyQuery: (query) => query.or(machineInvestmentTerms.flatMap((term) => searchableColumns.map((column) => `${column}.ilike.%${term}%`)).join(",")),
    filter: (row) => {
      const text = financeRowText(row);
      return text.includes("machine investment") || text.includes("machine purchase") || text.includes("equipment") || text.includes("asset");
    },
  });
}
