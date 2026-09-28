import Link from 'next/link';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';

/** Keep intake above independent dashboard readers; native issue authorization is unchanged. */
export async function CrmQuickIssueAction() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' ||
      !hasAnyRole(profile, ['owner', 'admin', 'supervisor', 'crm'])) return null;
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  return <section data-crm-quick-issue dir={ar ? 'rtl' : 'ltr'}
    aria-label={ar ? 'تسجيل بلاغ عميل' : 'Customer issue intake'}
    className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
    <div className="min-w-0">
      <h2 className="font-semibold text-emerald-950">{ar ? 'وصلتك مشكلة من عميل؟' : 'A customer needs help?'}</h2>
      <p className="mt-1 text-sm text-emerald-950">{ar ? 'سجّلي الأساسيات الآن، ثم تابعي الحالة من سجل البلاغ.' : 'Record the essentials now, then follow up in the issue record.'}</p>
    </div>
    <Link href="/issues/new" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-800 px-5 py-3 font-semibold text-white hover:bg-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-900">
      {ar ? '+ بلاغ سريع' : '+ Quick issue'}
    </Link>
  </section>;
}
