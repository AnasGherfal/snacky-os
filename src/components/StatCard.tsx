export function StatCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className="surface-card"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</p>{note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}</div>;
}
