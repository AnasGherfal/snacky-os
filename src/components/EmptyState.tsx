export function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"><h3 className="text-base font-semibold text-slate-900">{title}</h3><p className="mt-2 text-sm text-slate-500">{body}</p></div>;
}
