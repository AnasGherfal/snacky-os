import { ReactNode } from "react";

type TrendSeries = {
  key: string;
  label: string;
  values: number[];
  strokeClass?: string;
};

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="surface-card overflow-hidden">
      <div className="border-b border-slate-200 pb-4">
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

export function TrendChart({
  labels,
  series,
  valueFormatter = compact,
}: {
  labels: string[];
  series: TrendSeries[];
  valueFormatter?: (value: number) => string;
}) {
  if (!labels.length || !series.length) return <p className="text-sm text-slate-500">No chart data available.</p>;
  const width = 760;
  const height = 270;
  const left = 52;
  const right = 18;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const allValues = series.flatMap((item) => item.values.map(finite));
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(1, ...allValues);
  const span = Math.max(1, maxValue - minValue);
  const x = (index: number) => labels.length <= 1 ? left + plotWidth / 2 : left + (index / (labels.length - 1)) * plotWidth;
  const y = (value: number) => top + ((maxValue - finite(value)) / span) * plotHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => maxValue - (index / 4) * span);
  const palette = ["stroke-sky-600", "stroke-emerald-600", "stroke-amber-600", "stroke-violet-600"];

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full" role="img" aria-label="Trend chart">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="stroke-slate-200" strokeWidth="1" />
              <text x={left - 8} y={y(tick) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">{valueFormatter(tick)}</text>
            </g>
          ))}
          {labels.map((label, index) => (
            <text key={`${label}-${index}`} x={x(index)} y={height - 18} textAnchor="middle" className="fill-slate-500 text-[11px]">{label}</text>
          ))}
          {series.map((item, seriesIndex) => {
            const points = item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
            const strokeClass = item.strokeClass ?? palette[seriesIndex % palette.length];
            return (
              <g key={item.key}>
                <polyline points={points} fill="none" className={strokeClass} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
                {item.values.map((value, index) => (
                  <circle key={`${item.key}-${index}`} cx={x(index)} cy={y(value)} r="3.5" className={`${strokeClass} fill-white`} strokeWidth="2" />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
        {series.map((item, index) => (
          <div key={item.key} className="flex items-center gap-2">
            <span className={`h-0.5 w-6 ${["bg-sky-600", "bg-emerald-600", "bg-amber-600", "bg-violet-600"][index % 4]}`} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HorizontalBarChart({
  rows,
  valueFormatter = compact,
}: {
  rows: Array<{ label: string; value: number; note?: string }>;
  valueFormatter?: (value: number) => string;
}) {
  if (!rows.length) return <p className="text-sm text-slate-500">No chart data available.</p>;
  const max = Math.max(1, ...rows.map((row) => Math.max(0, finite(row.value))));
  return (
    <div className="space-y-4">
      {rows.map((row) => {
        const value = Math.max(0, finite(row.value));
        const width = Math.max(value > 0 ? 3 : 0, (value / max) * 100);
        return (
          <div key={row.label}>
            <div className="mb-1 flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-slate-800">{row.label}</div>
                {row.note ? <div className="text-xs text-slate-500">{row.note}</div> : null}
              </div>
              <div className="shrink-0 font-semibold text-slate-950">{valueFormatter(value)}</div>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-sky-600" style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
