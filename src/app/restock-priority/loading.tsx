export default function RestockPriorityLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading restock priority">
      <div className="space-y-2">
        <div className="h-8 w-56 animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded bg-slate-100" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="surface-card p-4">
            <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
            <div className="mt-3 h-8 w-16 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <section className="surface-card p-4">
        <div className="h-5 w-44 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </section>
    </div>
  );
}
