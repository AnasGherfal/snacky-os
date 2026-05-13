import { AppShell } from "@/components/AppShell";
import { EmptyState, PageHeader } from "@/components/ui";

export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader title="Settings" subtitle="Authentication, roles, and system configuration foundation." />
      <EmptyState title="Settings foundation ready" body="User and role management will be expanded here after the app-level auth foundation is validated." />
    </AppShell>
  );
}
