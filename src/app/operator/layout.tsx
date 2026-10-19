import Link from 'next/link';
import { type ReactNode } from 'react';
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from '@/lib/auth';
import { canExecuteRoutes, isOperatorRole, isOwnerAdminRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { OperatorHomeShortcuts } from '@/components/operator/OperatorHomeShortcuts';

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
  // The RPC needs the signed-in operator JWT. A service-role client would
  // have no auth.uid() and incorrectly return an empty shared queue.
  const sharedResult = db && isOperatorRole(profile)
    ? await db.rpc('snacky_available_machine_issues_v1') : null;
  const availableCount = sharedResult && !sharedResult.error && Array.isArray(sharedResult.data)
    ? sharedResult.data.length : null;
  return <>
    <OperatorHomeShortcuts>
    {isOperatorRole(profile) ? (
      <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${availableCount ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`} dir={ar ? 'rtl' : 'ltr'}>
        <div>
          <strong className="text-slate-950">{ar ? 'بلاغات الماكينات المتاحة للاستلام' : 'Machine issues ready to claim'}</strong>
          {availableCount !== null ? <span className="ms-2 inline-flex rounded-full bg-amber-200 px-2.5 py-1 font-bold text-amber-950">{availableCount}</span> : null}
          <p className="mt-1 text-xs text-slate-600">{ar ? 'يمكن لأي مشغّل استلام البلاغ. أول مستلم يصبح مسؤولاً عن متابعته.' : 'All operators can view; the first to claim owns the field visit.'}</p>
        </div>
        <Link className="btn-primary min-h-11" href="/operator/issues">{ar ? 'فتح بلاغات الماكينات' : 'Open machine issues'}</Link>
      </div>
    ) : null}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm" dir={ar ? 'rtl' : 'ltr'}>
      <span>{ar ? 'إجراءات مشاكل العملاء المسندة إليك' : 'Customer issue actions assigned to you'}{count !== null ? <strong className="ms-2">{count}</strong> : null}</span>
      <Link className="btn-secondary min-h-10" href="/operator/issues/actions">{ar ? 'فتح مهام العملاء' : 'Open customer tasks'}</Link>
    </div>
    <nav aria-label={ar ? "عمل اليوم" : "Today’s Work"} dir={ar ? "rtl" : "ltr"} className="mb-4 flex flex-wrap gap-2">
      <Link className="btn-secondary min-h-11" prefetch={false} href="/operator/today-work">{ar ? "أولويات التعبئة — عرض فقط" : "Refill priorities — view only"}</Link>
      <Link className="btn-secondary min-h-11" prefetch={false} href="/operator/daily-duties">{ar ? 'واجبات التعبئة' : 'Required refills'}</Link>
      <Link className="btn-secondary min-h-11" prefetch={false} href="/operator/product-plan">{ar ? 'خطة المنتجات — معاينة' : 'Product plan — preview'}</Link>
      {isOwnerAdminRole(profile) ? <Link className="btn-secondary min-h-11" prefetch={false} href="/settings/smart-work-coverage">{ar ? 'إعداد التغطية وساعات العمل' : 'Coverage & work hours setup'}</Link> : null}
    </nav>
    </OperatorHomeShortcuts>
    {children}
  </>;
}
