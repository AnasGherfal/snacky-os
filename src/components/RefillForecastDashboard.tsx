import Link from "next/link";
import { ChartCard, HorizontalBarChart } from "@/components/DecisionCharts";
import { DataTable, MobileCardList, MobileField, MobileRecordCard } from "@/components/ui";
import type { MachineRefillForecast, RefillForecastStatus } from "@/lib/refill-forecast";

const statusStyle: Record<RefillForecastStatus, string> = {
  fill_now: "border-rose-200 bg-rose-100 text-rose-800",
  fill_today: "border-orange-200 bg-orange-100 text-orange-800",
  fill_next_open: "border-sky-200 bg-sky-100 text-sky-800",
  monitor: "border-amber-200 bg-amber-100 text-amber-800",
  healthy: "border-emerald-200 bg-emerald-100 text-emerald-800",
  data_stale: "border-slate-300 bg-slate-100 text-slate-700",
};

const weekday = new Map([
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"],
]);

function StatusPill({ forecast }: { forecast: MachineRefillForecast }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyle[forecast.status]}`}>{forecast.statusLabel}</span>;
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function days(value: number | null) {
  if (value === null) return "Learning";
  if (value <= 0.5) return "< 1 day";
  return `${value.toFixed(value < 10 ? 1 : 0)} days`;
}

function schedule(value: number[]) {
  return value.map((day) => weekday.get(day)).filter(Boolean).join(" · ");
}

function snapshotAge(value: number | null) {
  if (value === null) return "Missing";
  if (value < 1) return "Current";
  if (value < 24) return `${Math.round(value)}h old`;
  return `${Math.round(value / 24)}d old`;
}

export function RefillForecastDashboard({
  forecasts,
  variant = "full",
}: {
  forecasts: MachineRefillForecast[];
  variant?: "full" | "overview";
}) {
  const fillNow = forecasts.filter((row) => row.status === "fill_now").length;
  const fillToday = forecasts.filter((row) => row.status === "fill_today").length;
  const canWait = forecasts.filter((row) => row.status === "fill_next_open" || row.status === "monitor").length;
  const stale = forecasts.filter((row) => row.status === "data_stale").length;
  const storageShortages = forecasts.filter((row) => row.storageShortageUnits > 0).length;
  const observed = forecasts.filter((row) => row.averageDailyUnits > 0).sort((a, b) => b.averageDailyUnits - a.averageDailyUnits);
  const remaining = forecasts.filter((row) => row.daysToEmpty !== null && row.status !== "data_stale").sort((a, b) => (a.daysToEmpty ?? 0) - (b.daysToEmpty ?? 0));
  const urgentAll = forecasts.filter((row) => row.status !== "healthy");
  const urgent = urgentAll.slice(0, 6);

  if (variant === "overview") {
    return (
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-gradient-to-br from-orange-50 via-white to-emerald-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-700">Today&apos;s operating decision</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Which machines should be filled?</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Live XY stock, lane capacity, observed depletion, site opening days, and storage availability—ordered by what needs action first.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/routes/new" className="btn-primary">Create today&apos;s route</Link>
              <Link href="/refills" className="btn-secondary">Open full refill dashboard</Link>
            </div>
          </div>

          <div className="mt-5 grid gap-3 grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3"><div className="text-xs font-semibold text-rose-700">Fill now</div><div className="mt-1 text-2xl font-semibold text-rose-950">{fillNow}</div></div>
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-3"><div className="text-xs font-semibold text-orange-700">Fill today</div><div className="mt-1 text-2xl font-semibold text-orange-950">{fillToday}</div></div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3"><div className="text-xs font-semibold text-sky-700">Can wait</div><div className="mt-1 text-2xl font-semibold text-sky-950">{canWait}</div></div>
            <div className={`rounded-xl border p-3 ${storageShortages ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-xs font-semibold ${storageShortages ? "text-rose-700" : "text-emerald-700"}`}>Storage shortage</div><div className={`mt-1 text-2xl font-semibold ${storageShortages ? "text-rose-950" : "text-emerald-950"}`}>{storageShortages}</div></div>
            <div className={`col-span-2 rounded-xl border p-3 xl:col-span-1 ${stale ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-xs font-semibold ${stale ? "text-amber-700" : "text-emerald-700"}`}>Refresh XY data</div><div className={`mt-1 text-2xl font-semibold ${stale ? "text-amber-950" : "text-emerald-950"}`}>{stale}</div></div>
          </div>
        </div>

        <div className="p-5">
          {!forecasts.length ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-600">No active machines are available for refill forecasting.</div>
          ) : !urgent.length ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Every machine is healthy. No refill visit is currently needed.</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {urgent.map((row) => (
                <div key={row.machineId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/machines/${row.machineId}`} className="font-semibold text-slate-950 hover:underline">{row.machineName}</Link>
                      <div className="mt-0.5 text-xs text-slate-500">{row.machineCode || "No machine code"} · action {row.actionDate}</div>
                    </div>
                    <StatusPill forecast={row} />
                  </div>
                  <p className="mt-3 text-sm text-slate-700">{row.reason}</p>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div><div className="text-xs text-slate-500">Stock</div><div className="font-semibold text-slate-900">{row.currentUnits}/{row.capacityUnits} · {percent(row.stockPercent)}</div></div>
                    <div><div className="text-xs text-slate-500">Runway</div><div className="font-semibold text-slate-900">{days(row.daysToEmpty)}</div></div>
                    <div><div className="text-xs text-slate-500">Bring</div><div className="font-semibold text-slate-900">{row.unitsToTarget} units</div></div>
                    <div><div className="text-xs text-slate-500">Empty lanes</div><div className="font-semibold text-slate-900">{row.emptyLanes}</div></div>
                  </div>
                  {row.storageShortageUnits > 0 ? <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">Storage is short by {row.storageShortageUnits} units. Swap unavailable products or reduce them to 0.</div> : null}
                </div>
              ))}
            </div>
          )}
          {urgentAll.length > urgent.length ? <div className="mt-4 text-right"><Link href="/refills" className="link-secondary">View all {urgentAll.length} machines needing attention</Link></div> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">When each machine should be filled</h2>
          <p className="mt-1 max-w-4xl text-sm text-slate-600">Live XY quantities plus 14-day depletion, recorded fill quantities, storage coverage, and each site&apos;s operating calendar. Empty lanes always outrank percentage rules.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/routes/new" className="btn-primary">Create today&apos;s route</Link>
          <Link href="/machines" className="btn-secondary">Configure machine policies</Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4"><div className="text-sm font-medium text-rose-700">Fill now</div><div className="mt-1 text-3xl font-semibold text-rose-950">{fillNow}</div></div>
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4"><div className="text-sm font-medium text-orange-700">Fill today</div><div className="mt-1 text-3xl font-semibold text-orange-950">{fillToday}</div></div>
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4"><div className="text-sm font-medium text-sky-700">Can safely wait</div><div className="mt-1 text-3xl font-semibold text-sky-950">{canWait}</div></div>
        <div className={`rounded-2xl border p-4 ${stale ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-sm font-medium ${stale ? "text-amber-700" : "text-emerald-700"}`}>XY data needing refresh</div><div className={`mt-1 text-3xl font-semibold ${stale ? "text-amber-950" : "text-emerald-950"}`}>{stale}</div></div>
      </div>

      {forecasts.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Observed machine depletion" subtitle="Estimated units consumed per day from XY stock changes, corrected with recorded refill quantities.">
            <HorizontalBarChart rows={observed.slice(0, 10).map((row) => ({ label: row.machineName, value: Number(row.averageDailyUnits.toFixed(1)), note: `${row.trendLabel} · ${row.policySource}` }))} valueFormatter={(value) => `${value.toFixed(1)} units/day`} />
          </ChartCard>
          <ChartCard title="Projected stock runway" subtitle="The shortest machine/product runway appears first. Closure days are considered in the action status.">
            <HorizontalBarChart rows={remaining.slice(0, 10).map((row) => ({ label: row.machineName, value: Number((row.daysToEmpty ?? 0).toFixed(1)), note: row.statusLabel }))} valueFormatter={(value) => `${value.toFixed(1)} days`} />
          </ChartCard>
        </div>
      ) : null}

      <MobileCardList>
        {forecasts.map((row) => (
          <MobileRecordCard key={row.machineId}>
            <div className="flex items-start justify-between gap-3">
              <div><div className="font-semibold text-slate-950">{row.machineName}</div><div className="text-xs text-slate-500">{row.machineCode}</div></div>
              <StatusPill forecast={row} />
            </div>
            <p className="mt-3 text-sm text-slate-700">{row.reason}</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MobileField label="Stock">{row.currentUnits}/{row.capacityUnits} · {percent(row.stockPercent)}</MobileField>
              <MobileField label="Projected runway">{days(row.daysToEmpty)}</MobileField>
              <MobileField label="Bring to target">{row.unitsToTarget} units</MobileField>
              <MobileField label="Trend">{row.averageDailyUnits.toFixed(1)}/day · {row.trendLabel}</MobileField>
              <MobileField label="Empty / low lanes">{row.emptyLanes} / {row.lowLanes}</MobileField>
              <MobileField label="Action date">{row.actionDate}</MobileField>
            </div>
            {row.storageShortageUnits > 0 ? <p className="mt-3 rounded-lg bg-rose-50 p-2 text-xs font-medium text-rose-800">Storage is short by {row.storageShortageUnits} units for this target.</p> : null}
            <div className="mt-3 flex gap-3 text-sm font-semibold"><Link className="link-secondary" href={`/machines/${row.machineId}`}>Machine history</Link><Link className="link-secondary" href={`/machines/${row.machineId}/edit`}>Policy</Link></div>
          </MobileRecordCard>
        ))}
      </MobileCardList>

      <DataTable className="hidden md:block" headers={["Machine", "Action", "Stock", "Empty / low lanes", "Observed trend", "Runway", "Bring", "Storage", "Operating days", "XY age", "Policy"]}>
        {forecasts.map((row) => (
          <tr key={row.machineId}>
            <td><Link className="font-semibold text-slate-950 hover:underline" href={`/machines/${row.machineId}`}>{row.machineName}</Link><div className="text-xs text-slate-500">{row.machineCode}</div></td>
            <td><StatusPill forecast={row} /><div className="mt-1 max-w-56 text-xs text-slate-500">{row.reason}</div><div className="mt-1 text-xs font-medium text-slate-700">{row.actionDate}</div></td>
            <td className="font-semibold">{row.currentUnits}/{row.capacityUnits}<div className="text-xs font-normal text-slate-500">{percent(row.stockPercent)}</div></td>
            <td>{row.emptyLanes} / {row.lowLanes}</td>
            <td>{row.averageDailyUnits.toFixed(1)} units/day<div className="text-xs text-slate-500">{row.trendLabel}</div></td>
            <td>{days(row.daysToEmpty)}</td>
            <td>{row.unitsToTarget}</td>
            <td>{row.storageShortageUnits > 0 ? <span className="font-semibold text-rose-700">Short {row.storageShortageUnits}</span> : `${row.storageFillableUnits} available`}</td>
            <td>{schedule(row.openDays)}</td>
            <td>{snapshotAge(row.snapshotAgeHours)}</td>
            <td><Link className="link-secondary" href={`/machines/${row.machineId}/edit`}>Edit</Link></td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
