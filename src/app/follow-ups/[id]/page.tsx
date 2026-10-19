import { Suspense } from 'react';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { RepairManualSales } from '@/components/RepairManualSales';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function RepairSalesEntry({ taskId }: { taskId: string }) {
  const profile = await getCurrentProfile();
  const db = await getAuthenticatedSupabaseServerClient();
  if (!profile || profile.active_status !== 'active' || !db) return null;
  // The RPC verifies task access and machine linkage; do not use a service-role
  // client to expose other operators' repairs. Non-field tasks have no sales UI.
  const { data, error } = await db.rpc('snacky_repair_sale_workspace_v1', { p_task_id: taskId });
  if (error || data?.ok !== true || data.task_id !== taskId) return null;
  const { getServerI18n } = await import('@/lib/i18n/server');
  const { locale } = await getServerI18n();
  return <div className="mb-5"><RepairManualSales taskId={taskId} userId={profile.id} ar={locale === 'ar'} /></div>;
}

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<CrmSearchParams>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  return <>
    <Suspense fallback={null}><RepairSalesEntry taskId={id} /></Suspense>
    <CrmWorkspace section="task" id={id} searchParams={filters} />
  </>;
}
