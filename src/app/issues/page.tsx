import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<CrmSearchParams> }) {
 const profile = await getCurrentProfile();
 if (profile && !hasAnyRole(profile, ['owner','admin','supervisor','crm'])) redirect('/operator/issues');
 const { locale } = await getServerI18n();
 const ar = locale === 'ar';
 return <>
  <section className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4" dir={ar ? 'rtl' : 'ltr'}>
   <h2 className="font-bold text-emerald-950">{ar ? 'مشاكل العملاء وأعطال الماكينات' : 'Customer issues & machine faults'}</h2>
   <p className="mt-1 text-sm text-emerald-900">{ar ? 'افتح البلاغ للإسناد إلى مشغّل، أو متابعة الإصلاح والصور والمبيعات اليدوية داخل نفس السجل.' : 'Open an issue to assign an operator and see the repair, proof and manual sales in the same record.'}</p>
   <nav className="mt-3 flex flex-wrap gap-2" aria-label={ar ? 'أنواع البلاغات' : 'Issue views'}>
    <Link className="btn-secondary" href="/issues">{ar ? 'كل البلاغات' : 'All issues'}</Link>
    <Link className="btn-secondary" href="/issues?type=machine_unavailable">{ar ? 'الماكينات لا تعمل' : 'Machines not working'}</Link>
    <Link className="btn-secondary" href="/issues?status=resolved">{ar ? 'تم الحل / السجل' : 'Resolved / history'}</Link>
    <Link className="btn-primary" href="/issues/new?dispatch=operator">{ar ? 'بلاغ عطل ماكينة' : 'Report machine fault'}</Link>
   </nav>
  </section>
  <CrmWorkspace section="issue" searchParams={await searchParams} />
 </>;
}
