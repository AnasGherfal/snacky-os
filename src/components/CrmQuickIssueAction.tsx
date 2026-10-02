import Link from 'next/link';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';

export async function CrmQuickIssueAction() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' ||
      !hasAnyRole(profile, ['owner', 'admin', 'supervisor', 'crm'])) return null;
  const { locale } = await getServerI18n();
  const ar = locale === 'ar';
  return <section data-crm-quick-issue dir={ar ? 'rtl' : 'ltr'}
    aria-label={ar ? 'تسجيل مشكلة عميل أو عطل ماكينة' : 'Customer or machine issue intake'}
    className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-semibold text-emerald-950">{ar ? 'مشكلة عميل أو ماكينة لا تعمل؟' : 'Customer issue or machine not working?'}</h2>
        <p className="mt-1 text-sm text-emerald-950">{ar ? 'بلاغ عطل الماكينة يصل مباشرةً إلى قائمة المشغّلين بعد الحفظ.' : 'A machine-failure report goes directly to the shared operator queue after saving.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/issues/new?dispatch=operator" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-rose-700 px-5 py-3 font-semibold text-white hover:bg-rose-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-900">
          {ar ? '⚠️ ماكينة لا تعمل — إشعار المشغّلين' : '⚠️ Machine not working — notify operators'}
        </Link>
        <Link href="/issues/new" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-800 px-5 py-3 font-semibold text-white hover:bg-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-900">
          {ar ? '+ مشكلة عميل' : '+ Customer issue'}
        </Link>
      </div>
    </div>
  </section>;
}
