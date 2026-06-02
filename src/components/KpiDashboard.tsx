import { ReactNode } from "react";

export type BarListRow = {
  label: string;
  value: number;
  detail?: string;
};

export function KpiSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="surface-card">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function KpiLoadWarning({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
      This KPI section could not load: {message}
    </div>
  );
}

export function BarList({
  rows,
  valueFormatter = (value) => String(value),
}: {
  rows: BarListRow[];
  valueFormatter?: (value: number) => string;
}) {
  const maxValue = Math.max(...rows.map((row) => row.value), 0);

  if (!rows.length) {
    return <p className="text-sm text-slate-500">No data available.</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const width = maxValue > 0 ? Math.max((row.value / maxValue) * 100, 3) : 0;

        return (
          <div key={row.label} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-800">{row.label}</div>
                {row.detail ? <div className="text-xs text-slate-500">{row.detail}</div> : null}
              </div>
              <div className="shrink-0 font-semibold text-slate-900">{valueFormatter(row.value)}</div>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-slate-900" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function InsightList({ items }: { items: string[] }) {
  if (!items.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-sm font-semibold text-slate-900">Signals</div>
      <ul className="mt-2 space-y-1 text-sm text-slate-600">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
