import { AppShell } from "@/components/AppShell";

export default function OperatorPage() {
  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">Operator App</h1>
      <p className="mt-2 text-slate-500">Mobile-first workflow. This will become the daily route, pick list, refill checklist, cash collection, and photo proof screen.</p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[
          ["1. Start route", "Operator sees only today’s assigned machines."],
          ["2. Pick stock", "System shows total products to take from storage."],
          ["3. Visit machine", "System shows exact products and quantities to fill."],
          ["4. Collect cash", "Operator enters actual cash; system compares with VMS expected."],
          ["5. Clean + photo", "Stop cannot be completed without checklist and final photo."],
          ["6. Return leftovers", "Remaining operator-bag stock returns to storage."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-slate-500">{body}</p>
          </div>
        ))}
      </div>
    </AppShell>
  );
}
