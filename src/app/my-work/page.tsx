import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
import {CrmLeadFocusOverview} from '@/components/CrmLeadFocusOverview';
import {CrmRelationshipOverview} from '@/components/CrmRelationshipOverview';
import {CrmNotesSummary} from '@/components/CrmNotesSummary';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}){return <><CrmNotesSummary/><CrmLeadFocusOverview/><CrmWorkspace section="work" searchParams={await searchParams}/><CrmRelationshipOverview/></>;}
