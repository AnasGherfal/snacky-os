import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { CrmForm } from '@/components/CrmForm';
import { PageHeader, ErrorState } from '@/components/ui';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { getServerI18n } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<CrmSearchParams> }) {
  const params = await searchParams;
  if (params.dispatch !== 'operator') return <CrmWorkspace section="issue" create searchParams={params} />;

  const profile = await getCurrentProfile();
  if (!profile) redirect('/login');
  if (profile.active_status !== 'active') redirect('/unauthorized');
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  if (!hasAnyRole(profile, ['owner', 'admin', 'supervisor', 'crm'])) {
    return <div className="space-y-4">
      <ErrorState title={tr('Machine fault reporting requires management', 'تسجيل عطل الماكينة يحتاج صلاحية الإدارة')}
        body={tr('You can claim available machine faults from the operator queue.', 'تقدر تستلم أعطال الماكينات المتاحة من قائمة المشغّلين.')}
        action={<Link href="/operator/issues" className="btn-primary">{tr('Open machine fault queue', 'افتح قائمة أعطال الماكينات')}</Link>} />
    </div>;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return <ErrorState title={tr('Cannot load machine list', 'تعذر تحميل الماكينات')}
    body={tr('Machine list unavailable. No fault has been recorded.', 'قائمة الماكينات غير متاحة. لم يتم تسجيل أي عطل.')} />;
  const { data: machines, error } = await admin.from('machines')
    .select('id,name,machine_code,status')
    .neq('status', 'inactive')
    .order('name', { ascending: true });
  if (error) return <ErrorState title={tr('Cannot load machine list', 'تعذر تحميل الماكينات')}
    body={tr('Please retry. No fault has been recorded.', 'أعد المحاولة. لم يتم تسجيل أي عطل.')} />;

  return <div className="space-y-5" dir={ar ? 'rtl' : 'ltr'}>
    <PageHeader title={tr('Report machine not working', 'تسجيل ماكينة لا تعمل')}
      subtitle={tr('Select the machine and describe the fault. Saving creates an operator task. Assign a specific operator on the issue page, or leave it open for Noury or Yamen to claim.', 'اختر الماكينة ووصف العطل. الحفظ ينشئ مهمة للمشغّل؛ بعدها تقدر تسندها لنوري أو يامن من البلاغ، أو تخلي أحدهم يستلمها من القائمة.')}
      action={<Link className="btn-secondary" href="/issues">{tr('Back to issues', 'العودة للبلاغات')}</Link>} />
    <section className="surface-card">
      <CrmForm action="machine.report" userId={profile.id}
        fields={[
          { name: 'machine_id', label: tr('Machine', 'الماكينة'), type: 'select', required: true, value: '', options: [
            { value: '', label: tr('Select a machine', 'اختر الماكينة') },
            ...(machines ?? []).map(machine => ({ value: machine.id, label: machine.name + (machine.machine_code ? ' · ' + machine.machine_code : '') })),
          ] },
          { name: 'description', label: tr('What is wrong?', 'شن العطل؟'), type: 'textarea', required: true, value: '',
            hint: tr('Describe the actual fault (at least 3 characters).', 'اكتب العطل الفعلي (3 حروف على الأقل).') },
          { name: 'priority', label: tr('Priority', 'الأولوية'), type: 'select', required: true, value: 'high',
            options: [
              { value: 'normal', label: tr('Normal', 'عادي') },
              { value: 'high', label: tr('High', 'عالي') },
              { value: 'critical', label: tr('Critical', 'عاجل جداً') },
            ] },
        ]}
        submitLabel={tr('Save fault and create operator task', 'حفظ العطل وإنشاء مهمة للمشغّل')} />
    </section>
    <p className="text-sm text-slate-600">{tr('After saving, open the issue to assign Noury or Yamen immediately. Operators can also claim it from their machine-fault queue.', 'بعد الحفظ افتح البلاغ لإسناده لنوري أو يامن مباشرةً، أو يقدر المشغّل يستلمه من قائمة الأعطال.')}</p>
  </div>;
}
