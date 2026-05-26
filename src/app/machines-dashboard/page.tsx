import { BarList, KpiSection } from "@/components/KpiDashboard";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import { formatInteger, formatLydOrDash, groupCount, latestObservedMonth, monthKey, salesAmount } from "@/lib/kpi";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export default async function MachinesDashboardPage() {
  await requireCurrentProfileForPath("/machines-dashboard");
  const supabase = getSupabaseServerClient();
  const [salesResult, machinesResult, refillResult, historicalRefillResult, stockResult, issuesResult, cashResult] = supabase
    ? await Promise.all([
        supabase.from("vms_sales_clean").select("id, machine_id, product_id, units_sold, net_sales_amount, gross_profit_amount, sale_date, sales_month, cost_missing"),
        supabase.from("machines").select("id, machine_code, name, status, target_nsm, rent_amount, location:locations(id, name)").order("name"),
        supabase.from("refill_orders").select("id, machine_id, status, generated_at, completed_at"),
        supabase.from("machine_refill_history").select("id, machine_id, machine_name, fill_status, issues_found, refill_at"),
        supabase.from("vms_stock_snapshots").select("machine_id, current_qty").eq("import_row_status", "imported"),
        supabase.from("issues").select("id, machine_id, status"),
        supabase.from("cash_collections").select("machine_id, variance"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const sales = ((salesResult.data ?? []) as any[]).map((row) => ({
    ...row,
    sold_qty: row.units_sold,
    sales_amount: row.net_sales_amount,
    period_end: row.sale_date,
  }));
  const machines = (machinesResult.data ?? []) as any[];
  const refills = (refillResult.data ?? []) as any[];
  const historicalRefills = (historicalRefillResult.data ?? []) as any[];
  const stockouts = groupCount(((stockResult.data ?? []) as any[]).filter((row) => Number(row.current_qty ?? 0) <= 0 && row.machine_id), (row) => String(row.machine_id));
  const issues = groupCount(((issuesResult.data ?? []) as any[]).filter((row) => row.machine_id), (row) => String(row.machine_id));
  const openIssues = groupCount(((issuesResult.data ?? []) as any[]).filter((row) => row.machine_id && row.status !== "resolved" && row.status !== "closed"), (row) => String(row.machine_id));
  const cashVariance = new Map<string, number>();
  ((cashResult.data ?? []) as any[]).forEach((row) => {
    if (!row.machine_id) return;
    cashVariance.set(String(row.machine_id), (cashVariance.get(String(row.machine_id)) ?? 0) + Number(row.variance ?? 0));
  });

  const latestMonth = latestObservedMonth(sales);
  const completedRefills = refills.filter((row) => row.status === "completed" || row.completed_at);
  const historicalRefillCounts = groupCount(historicalRefills.filter((row) => row.machine_id), (row) => String(row.machine_id));
  const machineMetrics = machines.map((machine) => {
    const machineSales = sales.filter((row) => row.machine_id === machine.id);
    const latestMonthSales = latestMonth ? machineSales.filter((row) => monthKey(row.period_end) === latestMonth) : [];
    const revenue = machineSales.reduce((sum, row) => sum + salesAmount(row), 0);
    const nsm = latestMonthSales.reduce((sum, row) => sum + salesAmount(row), 0);
    const targetNsm = Number(machine.target_nsm ?? 0);
    const grossProfitRows = latestMonthSales.map((row) => row.cost_missing ? null : Number(row.gross_profit_amount ?? 0));
    const hasProfitData = grossProfitRows.some((value) => value !== null);
    const grossProfit = grossProfitRows.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const profitAfterRent = hasProfitData ? grossProfit - Number(machine.rent_amount ?? 0) : null;

    return {
      id: machine.id,
      code: machine.machine_code,
      name: machine.name,
      status: machine.status,
      location: machine.location?.name ?? "No location",
      revenue,
      nsm,
      targetNsm,
      targetGap: nsm - targetNsm,
      refillCount: completedRefills.filter((row) => row.machine_id === machine.id).length + (historicalRefillCounts.get(String(machine.id)) ?? 0),
      stockoutCount: stockouts.get(String(machine.id)) ?? 0,
      issueCount: issues.get(String(machine.id)) ?? 0,
      openIssueCount: openIssues.get(String(machine.id)) ?? 0,
      cashVariance: cashVariance.get(String(machine.id)) ?? 0,
      profitAfterRent,
    };
  });

  const totalSales = machineMetrics.reduce((sum, row) => sum + row.revenue, 0);
  const totalNsm = machineMetrics.reduce((sum, row) => sum + row.nsm, 0);
  const totalCashVariance = machineMetrics.reduce((sum, row) => sum + row.cashVariance, 0);
  const rankedSales = [...machineMetrics].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const targetComparison = [...machineMetrics].filter((row) => row.targetNsm > 0).sort((a, b) => b.targetGap - a.targetGap).slice(0, 10);

  return (
    <>
      <PageHeader title="Machine Dashboard" subtitle="Machine sales, NSM, refills, stockouts, issues, cash variance, and rent-aware profit." />

      {!supabase ? (
        <EmptyState title="Connect Supabase to activate machine KPIs" body="Add environment variables and restart the app." />
      ) : !machines.length ? (
        <EmptyState title="No machines yet" body="Create machines and upload VMS sales snapshots to populate machine KPIs." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiSection title="Total sales"><div className="text-3xl font-semibold">{lyd(totalSales)}</div></KpiSection>
            <KpiSection title={latestMonth ? `NSM ${latestMonth}` : "NSM"}><div className="text-3xl font-semibold">{sales.length ? lyd(totalNsm) : "-"}</div></KpiSection>
            <KpiSection title="Open issues"><div className="text-3xl font-semibold">{machineMetrics.reduce((sum, row) => sum + row.openIssueCount, 0)}</div></KpiSection>
            <KpiSection title="Cash variance"><div className="text-3xl font-semibold">{lyd(totalCashVariance)}</div></KpiSection>
          </div>

          {!sales.length ? <EmptyState title="No machine sales yet" body="VMS sales snapshots are required for sales, NSM, and profit metrics." /> : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <KpiSection title="Sales by machine">
              <BarList rows={rankedSales.map((row) => ({ label: row.name, value: row.revenue, detail: row.code }))} valueFormatter={lyd} />
            </KpiSection>
            <KpiSection title="Target NSM comparison" subtitle="Positive values are above target for the latest observed month.">
              {targetComparison.length ? (
                <BarList rows={targetComparison.map((row) => ({ label: row.name, value: Math.max(row.targetGap, 0), detail: `${lyd(row.nsm)} vs ${lyd(row.targetNsm)}` }))} valueFormatter={lyd} />
              ) : (
                <p className="text-sm text-slate-500">No machine targets available.</p>
              )}
            </KpiSection>
          </div>

          <KpiSection title="Machine KPI table">
            <DataTable headers={["Machine", "Status", "Location", "Sales", "NSM", "Target", "Refills", "Stockouts", "Issues", "Cash variance", "Profit after rent"]}>
              {machineMetrics.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="font-medium text-slate-900">{row.name}</div>
                    <div className="text-xs text-slate-500">{row.code}</div>
                  </td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>{row.location}</td>
                  <td>{lyd(row.revenue)}</td>
                  <td>{sales.length ? lyd(row.nsm) : "-"}</td>
                  <td>{row.targetNsm > 0 ? lyd(row.targetNsm) : "-"}</td>
                  <td>{formatInteger(row.refillCount)}</td>
                  <td>{formatInteger(row.stockoutCount)}</td>
                  <td>{formatInteger(row.issueCount)}</td>
                  <td>{lyd(row.cashVariance)}</td>
                  <td>{formatLydOrDash(row.profitAfterRent)}</td>
                </tr>
              ))}
            </DataTable>
          </KpiSection>
        </div>
      )}
    </>
  );
}
