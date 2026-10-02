import Link from 'next/link';
import { type ReactNode } from 'react';
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from '@/lib/auth';
import { canExecuteRoutes } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';

/** Keep assigned customer work visible without changing the refill workflow. */
export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || !canExecuteRoutes(profile)) return children;
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const db = await getAuthenticatedSupabaseServerClient();
  // RLS permits only the operator's assigned tasks; failed reads are not zero.
  const result = db && profile.team_member_id ? await db.from('crm_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('assigned_to', profile.team_member_id).eq('task_type', 'field_action')
    .neq('status', 'completed').eq('is_practice', false).is('archived_at', null) : null;
  const count = result && !result.error ? result.count : null;
  return <>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm" dir={ar ? 'rtl' : 'ltr'}>
      <span>{ar ? 'إجراءات مشاكل العملاء المسندة إليك' : 'Customer issue actions assigned to you'}{count !== null ? <strong className="ms-2">{count}</strong> : null}</span>
      <Link className="btn-secondary min-h-10" href="/operator/issues/actions">{ar ? 'فتح مهام العملاء' : 'Open customer tasks'}</Link>
    </div>
    {children}
  </>;
}
