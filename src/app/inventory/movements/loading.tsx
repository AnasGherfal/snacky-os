export default function InventoryMovementsLoading() {
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-72 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-96 max-w-full animate-pulse rounded bg-slate-200" />
        </div>
        <div className="surface-card grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded bg-slate-200" />
          ))}
        </div>
        <div className="surface-card space-y-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </div>
    </main>
  );
}
