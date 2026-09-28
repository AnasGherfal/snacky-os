import {Suspense} from 'react';
import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
import {CrmQuickIssueAction} from '@/components/CrmQuickIssueAction';
import {CrmSharedWorkShortcuts} from '@/components/CrmSharedWorkShortcuts';
import {CrmLeadFocusOverview} from '@/components/CrmLeadFocusOverview';
import {CrmRelationshipOverview} from '@/components/CrmRelationshipOverview';
import {CrmNotesSummary} from '@/components/CrmNotesSummary';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}) {
  const params=await searchParams;
  return <>
    <CrmQuickIssueAction/>
    <Suspense fallback={null}><CrmSharedWorkShortcuts/></Suspense>
    <Suspense fallback={null}><CrmNotesSummary/></Suspense>
    <Suspense fallback={null}><CrmLeadFocusOverview/></Suspense>
    <Suspense fallback={null}><CrmWorkspace section="work" searchParams={params}/></Suspense>
    <Suspense fallback={null}><CrmRelationshipOverview/></Suspense>
  </>;
}
