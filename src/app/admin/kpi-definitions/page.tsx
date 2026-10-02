import { DataTable, PageHeader, SectionCard } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";

const definitions = [
  ["Gross Sales", "Total VMS sales before refunds, fees, or adjustments when the VMS file provides that split."],
  ["Net Sales", "Gross sales after refunds or adjustments. If the file has no adjustment columns, net sales equals gross sales."],
  ["Units Sold", "Sum of sold quantity or transaction count from clean VMS sales rows."],
  ["Gross Profit", "Net sales minus product cost. Imported VMS profit is used when present; otherwise Snacky OS calculates it."],
  ["Product Cost", "Weighted average purchase cost from received purchase lines. Fallbacks: product average cost, latest purchase cost, current product cost, then legacy cost."],
  ["Machine Profit", "Gross profit by machine before rent on sales pages; machine dashboard subtracts machine rent where available."],
  ["NSM", "Net Sales per Machine per Month from kpi_machine_monthly."],
  ["Stock Velocity", "Units sold per day from clean VMS sales rows."],
  ["Days of Stock Remaining", "Current storage stock divided by average daily sales velocity."],
  ["Variance", "Actual collected cash minus VMS expected cash from cash collection records."],
  ["Growth", "Month-over-month change in net sales once multiple VMS sales months are imported."],
  ["Uptime", "Machine online status from VMS machine status reports where available."],
];

export default async function KpiDefinitionsPage() {
  await requireCurrentProfileForPath("/admin/kpi-definitions");

  return (
    <>
      <PageHeader title="KPI Definitions" subtitle="Admin reference for VMS sales, profit, inventory velocity, and reconciliation metrics." />
      <SectionCard>
        <DataTable headers={["KPI", "Definition"]}>
          {definitions.map(([name, definition]) => (
            <tr key={name}>
              <td className="font-medium text-slate-900">{name}</td>
              <td>{definition}</td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>
    </>
  );
}
