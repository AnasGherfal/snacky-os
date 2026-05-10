export function StatCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-bold tracking-tight">{value}</div>
      {note ? <div className="mt-2 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}
