export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <div className="text-lg font-semibold">{title}</div>
      <div className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{body}</div>
    </div>
  );
}
