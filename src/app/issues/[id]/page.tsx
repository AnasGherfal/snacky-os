import { Suspense } from 'react';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { IssueFieldWork } from '@/components/IssueFieldWork';
import { getServerI18n } from '@/lib/i18n/server';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
 params: Promise<{ id: string }>; searchParams: Promise<CrmSearchParams>;
}) {
 const { id } = await params;
 const { locale } = await getServerI18n();
 return <>
  <a href="#field-work" className="btn-primary mb-4 inline-flex min-h-12">{locale === 'ar' ? 'الإصلاح والمبيعات وإسناد المشغّل' : 'Repair, manual sales & operator assignment'}</a>
  <CrmWorkspace section="issue" id={id} searchParams={await searchParams} />
  <Suspense fallback={<p role="status">{locale === 'ar' ? 'جارٍ تحميل سجل الإصلاح…' : 'Loading repair record…'}</p>}><IssueFieldWork issueId={id} /></Suspense>
 </>;
}
