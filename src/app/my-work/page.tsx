import {Suspense} from 'react';
import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
import {CrmQuickIssueAction} from '@/components/CrmQuickIssueAction';
import {CrmLeadFocusOverview} from '@/components/CrmLeadFocusOverview';
import {CrmRelationshipOverview} from '@/components/CrmRelationshipOverview';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}) {
  const params=await searchParams;
  return <>
    <CrmQuickIssueAction/>
    <Suspense fallback={null}><CrmLeadFocusOverview/></Suspense>
    <Suspense fallback={null}><CrmWorkspace section="work" searchParams={params}/></Suspense>
    <Suspense fallback={null}><CrmRelationshipOverview/></Suspense>
  </>;
}
