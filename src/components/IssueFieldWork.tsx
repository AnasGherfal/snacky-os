import Link from 'next/link';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { getServerI18n } from '@/lib/i18n/server';
import { CrmDispatchTaskPanel } from '@/components/CrmDispatchPanel';
import { CrmIssueFieldQueueForm } from '@/components/CrmIssueFieldQueue';
import { CrmDocumentUpload } from '@/components/CrmClientTools';
import { RepairManualSales } from '@/components/RepairManualSales';
import type { CrmDispatchTask } from '@/lib/crm-dispatch';

type FieldTask = CrmDispatchTask & {
  can_act: boolean; assigned_name: string | null; proof_images: number;
  is_practice: boolean; notes: string | null;
  documents: Array<{ id: string; name: string; mime_type: string }>;
};
type FieldWorkspace = {
  ok: boolean; issue_id: string; user_id: string; staff: boolean; can_assign: boolean;
  issue_status: string; priority: string; machine_id: string | null; machine_name: string | null;
  operators: Array<{ id: string; name: string }>; tasks: FieldTask[];
};

/** Field tasks stay linked internally; the issue is their one visible home. */
export async function IssueFieldWork({ issueId }: { issueId: string }) {
  const profile = await getCurrentProfile();
  const db = await getAuthenticatedSupabaseServerClient();
  if (!profile || profile.active_status !== 'active' || !db) return null;
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const { data, error } = await db.rpc('snacky_issue_field_workspace_v1', { p_issue_id: issueId });
  if (error || data?.ok !== true || data.issue_id !== issueId || data.user_id !== profile.id) {
    return <section id="field-work" className="surface-card"><p role="alert">{tr('Could not load the repair record. Refresh the issue; do not create a duplicate.', 'تعذر تحميل سجل الإصلاح. حدّث البلاغ ولا تنشئ بلاغاً آخر.')}</p></section>;
  }
  const work = data as FieldWorkspace;
  const active = work.tasks.filter((task) => task.status !== 'completed');
  const available = active.length > 0 && active.every((task) => task.dispatch_state === 'available' && !task.assigned_to);
  const canAssign = work.can_assign && (!active.length || available);
  return <section id="field-work" className="my-6 space-y-4 scroll-mt-6" dir={ar ? 'rtl' : 'ltr'}>
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <h2 className="text-xl font-bold text-emerald-950">{tr('Repair, operator & manual sales', 'الإصلاح والمشغّل والمبيعات اليدوية')}</h2>
      <p className="mt-1 text-sm text-emerald-900">{work.machine_name ?? ''} · {tr('Everything stays under this issue. No separate Follow-up is needed.', 'كل شيء محفوظ داخل هذا البلاغ. لا تحتاج لفتح متابعة منفصلة.')}</p>
      {!work.staff ? <Link className="btn-secondary mt-3" href="/operator/issues">{tr('Back to my machine issues', 'العودة إلى بلاغات الماكينات')}</Link> : null}
    </div>
    {canAssign ? <CrmIssueFieldQueueForm issueId={issueId} priority={work.priority} operators={work.operators} ar={ar} /> : null}
    {available ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{tr('This issue is available to operators. CRM may assign it here instead; assignment and claim use the same record.', 'البلاغ متاح للمشغّلين للاستلام. يمكن لعلاقات العملاء إسناده هنا؛ الإسناد والاستلام لنفس السجل.')}</p> : null}
    {work.tasks.map((task) => <article key={task.id} id={`repair-${task.id}`} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <strong>{tr('Operator', 'المشغّل')}: {task.assigned_name ?? tr('Not claimed yet', 'لم يستلمه أحد بعد')}</strong>
        <span>{task.status === 'completed' ? tr('Completed visit — history preserved', 'زيارة مكتملة — السجل محفوظ') : tr('Active field work', 'عمل ميداني قائم')}</span>
      </div>
      {task.notes ? <p className="whitespace-pre-wrap rounded-lg bg-white p-3 text-sm">{task.notes}</p> : null}
      {task.can_act ? <section className="surface-card" id={`proof-${task.id}`}>
        <h3 className="mb-2 font-semibold">{tr('Repair photo / proof', 'صورة الإصلاح / الإثبات')}</h3>
        <CrmDocumentUpload kind="task" recordId={task.id} userId={profile.id} />
      </section> : null}
      {task.documents?.length ? <div className="space-y-1">{task.documents.map((doc) => <a key={doc.id} className="block text-sm text-sky-800 underline" href={`/api/crm/documents/${doc.id}`} target="_blank" rel="noreferrer">{doc.name}</a>)}</div> : null}
      <CrmDispatchTaskPanel task={task} userId={profile.id} ar={ar} canAct={task.can_act} proofImages={Number(task.proof_images)} />
      {work.machine_id && !task.is_practice ? <RepairManualSales key={`${task.id}:${task.dispatch_state}:${work.issue_status}`} taskId={task.id} userId={profile.id} ar={ar} /> : null}
    </article>)}
    {!work.tasks.length && !canAssign ? <p className="text-sm text-slate-600">{tr('No field visits recorded for this issue.', 'لا توجد زيارات ميدانية مسجلة لهذا البلاغ.')}</p> : null}
  </section>;
}
