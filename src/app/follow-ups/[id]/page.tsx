import { Suspense } from 'react';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { RepairManualSales } from '@/components/RepairManualSales';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { getServerI18n } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

async function RepairSalesEntry({ taskId }: { taskId: string }) {
  const profile = await getCurrentProfile();
  const db = await getAuthenticatedSupabaseServerClient();
  if (!profile || profile.active_status !== 'active' || !db) return null;
  // Scope and machine linkage are verified using this signed-in user's JWT.
  const { data, error } = await db.rpc('snacky_repair_sale_workspace_v1', { p_task_id: taskId });
  if (error || data?.ok !== true || data.task_id !== taskId) return null;
  const { locale } = await getServerI18n();
  // A dispatch Start/Fixed action calls router.refresh(). Remount on a permission
  // change so the sale form does not retain an obsolete can_sell value.
  return <div className="mb-5"><RepairManualSales key={`${taskId}:${Boolean(data.can_sell)}`} taskId={taskId} userId={profile.id} ar={locale === 'ar'} /></div>;
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
