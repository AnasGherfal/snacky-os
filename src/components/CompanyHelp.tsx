import Link from 'next/link';
import type {ReactNode} from 'react';
import {getServerI18n} from '@/lib/i18n/server';
import {companyHubEnabled} from '@/lib/company-hub';
/** Static links only: a missing library cannot prevent existing operational work. */
export function CompanyHelp({section,ar}:{section:string;ar:boolean}){
 if(!companyHubEnabled)return null;
 const query=section==='lead'?'Visit a potential location':section==='issue'?'Handle a customer issue':section==='obligation'?'Follow up location rent':'';
 const href=section==='task'?'/company/people':query?`/company/guides?q=${encodeURIComponent(query)}`:'/company';
 return <div className="mb-4 flex flex-wrap gap-3 text-sm print:hidden" dir={ar?'rtl':'ltr'}><Link className="underline" href={href}>{ar?'تعليمات العمل والوثائق':'Instructions & company materials'}</Link><Link className="underline" href="/company/updates">{ar?'التحديثات والقراءة المطلوبة':'Updates & required reading'}</Link></div>;
}
export async function CompanyHelpLayout({section,children}:{section:string;children:ReactNode}){
 if(!companyHubEnabled)return <>{children}</>;
 const {locale}=await getServerI18n();
 return <><CompanyHelp section={section} ar={locale==='ar'}/>{children}</>;
}
