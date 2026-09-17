import {CrmLeadsWorkspace} from '@/components/CrmLeadsWorkspace';
import type {LeadSearchParams} from '@/lib/crm-lead-list';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<LeadSearchParams>}){return <CrmLeadsWorkspace searchParams={await searchParams}/>;}
