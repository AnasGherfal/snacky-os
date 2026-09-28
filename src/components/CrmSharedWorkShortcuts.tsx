import Link from 'next/link';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';

/** Navigation only: existing CRM RPCs continue to enforce record permissions. */
export async function CrmSharedWorkShortcuts() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' ||
      !hasAnyRole(profile, ['owner', 'admin', 'supervisor', 'crm'])) return null;

  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  const links = [
    ['/my-work?scope=mine&window=attention', 'My work', 'مهامي'],
    ['/my-work?scope=all&window=attention', 'Shared work', 'العمل المشترك'],
    ['/follow-ups?scope=all&type=meeting&window=week', 'Team visits this week', 'زيارات الفريق هذا الأسبوع'],
    ['/my-work?scope=all&window=overdue', 'Team overdue', 'متأخرات الفريق'],
  ] as const;

  return (
    <section className="surface-card mb-5 space-y-3" dir={ar ? 'rtl' : 'ltr'} aria-labelledby="crm-shared-work-title">
      <div>
        <h2 id="crm-shared-work-title" className="font-semibold text-slate-950">
          {ar ? 'فريق واحد، مسؤولية واضحة' : 'One team, clear ownership'}
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          {ar
            ? 'يبقى لكل جهة مسؤول متابعة واحد. تُسند الزيارة أو الخطوة التالية للشخص الذي سينفذها، وتُسجّل النتيجة في نفس الملف.'
            : 'Keep one relationship owner. Assign each visit or next step to the person doing it, and record the outcome on the same record.'}
        </p>
      </div>
      <nav className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label={ar ? 'اختصارات عمل فريق علاقات العملاء' : 'CRM team work shortcuts'}>
        {links.map(([href, en, arabic]) => (
          <Link key={href} href={href} className="btn-secondary min-h-11 justify-center text-center text-sm">
            {ar ? arabic : en}
          </Link>
        ))}
      </nav>
      <p className="text-xs text-slate-500">
        {ar ? 'العمل المشترك يعرض السجلات المسموح بها لحسابك فقط. استخدم مرشح الموظف لعرض عمل شخص محدد.'
          : 'Shared work shows only records your account may access. Use the employee filter to view one person’s work.'}
      </p>
    </section>
  );
}
