import { AppShell } from "@/components/AppShell";

export default function VmsImportPage() {
  return (
    <AppShell>
      <h1 className="text-3xl font-bold tracking-tight">VMS Import</h1>
      <p className="mt-2 text-slate-500">First version: CSV upload/import. Future version: direct VMS API sync.</p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Import workflow to build next</h2>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-600">
          <li>Upload VMS stock CSV.</li>
          <li>Create one vms_import_batches record.</li>
          <li>Store each row in vms_stock_snapshots.</li>
          <li>Match VMS product code/name to Snacky product_id.</li>
          <li>Update refill_recommendations view automatically.</li>
          <li>Show errors: unknown machine, unknown product, bad quantity, duplicate row.</li>
        </ol>
      </div>
    </AppShell>
  );
}
