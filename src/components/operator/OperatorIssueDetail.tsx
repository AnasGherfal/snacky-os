import Link from 'next/link';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { getServerI18n } from '@/lib/i18n/server';
import { IssueFieldWork } from '@/components/IssueFieldWork';

/** Operator-facing issue detail: only fault, machine and the actions needed to finish. */
export async function OperatorIssueDetail({ issueId }: { issueId: string }) {
  const profile = await getCurrentProfile();
  const db = await getAuthenticatedSupabaseServerClient();
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  if (!profile || profile.active_status !== 'active' || !db) {
    return <div role="alert" className="surface-card">{tr('Sign in to view your work.', 'سجّل الدخول لعرض عملك.')}</div>;
  }

  // Access is checked by the existing authenticated CRM workspace RPC. It
  // authorizes the reported-by operator or an operator assigned to field work.
  // Never use the service role here: no unrelated CRM/customer data is exposed.
  const { data, error } = await db.rpc('snacky_crm_workspace_v1', {
    p_section: 'issue', p_id: issueId, p_filters: {},
  });
  const record = data?.record;
  if (error || !record || record.kind !== 'issue' || record.id !== issueId) {
    return <section className="surface-card space-y-3" dir={ar ? 'rtl' : 'ltr'}>
      <h1 className="text-xl font-bold">{tr('Issue unavailable', 'البلاغ غير متاح')}</h1>
      <p role="alert">{tr('You may only view faults assigned to you or reported by you.', 'يمكنك عرض البلاغات المسندة إليك أو التي أبلغت عنها فقط.')}</p>
      <Link href="/operator/issues" className="btn-secondary">{tr('Back to machine issues', 'العودة لبلاغات الماكينات')}</Link>
    </section>;
  }
  const issue = record.data ?? {};
  const resolved = ['resolved', 'closed'].includes(String(record.status ?? issue.status));
  const machine = (data.machines ?? []).find((m: { id: string }) => m.id === issue.machine_id);
  const status = resolved ? tr('Solved', 'تم الإصلاح') : tr('Needs action', 'يحتاج إجراء');
  return <main className="mx-auto max-w-3xl space-y-4 pb-8" dir={ar ? 'rtl' : 'ltr'}>
    <Link href="/operator/issues" className="btn-secondary inline-flex min-h-11">{tr('← My machine issues', '← بلاغات الماكينات')}</Link>
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-950">{machine?.name || tr('Machine issue', 'بلاغ عطل ماكينة')}</h1>
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${resolved ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}>{status}</span>
      </div>
      <h2 className="mt-5 text-sm font-semibold text-slate-600">{tr('Reported problem', 'المشكلة المبلّغ عنها')}</h2>
      <p className="mt-1 whitespace-pre-wrap text-base leading-7 text-slate-950">{issue.description || tr('No description', 'لا يوجد وصف')}</p>
      {resolved && issue.resolution ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
        <h2 className="text-sm font-semibold text-emerald-900">{tr('How it was fixed', 'كيف تم الإصلاح')}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-emerald-950">{issue.resolution}</p>
      </div> : null}
    </section>
    <IssueFieldWork issueId={issueId} compact />
  </main>;
}
