import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { PrimaryButton, PageHeader } from "@/components/ui";

export default function OperatorPage() {
  return (
    <AppShell>
      <div className="space-y-6">
        <PageHeader
          title="Operator Dashboard"
          subtitle="Welcome to your daily refill workflow."
          action={<PrimaryButton href="/operator/routes">View My Routes</PrimaryButton>}
        />

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-sm text-slate-500 mb-1">Quick Action</div>
            <h3 className="font-semibold text-lg mb-2">Start Your Route</h3>
            <Link href="/operator/routes" className="btn-primary">
              View Routes
            </Link>
          </div>
        </div>

        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4">
          <h3 className="font-semibold text-blue-900 mb-2">Daily Workflow:</h3>
          <ol className="text-sm text-blue-800 space-y-1 ml-4 list-decimal">
            <li><strong>Pick stock:</strong> Collect products from storage</li>
            <li><strong>Visit stops:</strong> Go to each machine in order</li>
            <li><strong>Fill machines:</strong> Stock items as instructed</li>
            <li><strong>Collect cash:</strong> Record actual cash from each machine</li>
            <li><strong>Return leftovers:</strong> Put unused stock back in storage</li>
          </ol>
        </div>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
          <h3 className="font-semibold text-amber-900 mb-2">Important Reminders:</h3>
          <ul className="text-sm text-amber-800 space-y-1 ml-4 list-disc">
            <li>Only take the exact quantities shown by the system</li>
            <li>Visit machines in the order provided</li>
            <li>Always record actual cash collected (even if it varies)</li>
            <li>Report any machine issues or damage immediately</li>
            <li>Return all leftover stock before the day ends</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
