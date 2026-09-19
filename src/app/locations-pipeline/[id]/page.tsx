import {LeadCrmWorkspace} from '@/components/LeadCrmWorkspace';
import type {CrmSearchParams} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<CrmSearchParams>}){return <LeadCrmWorkspace id={(await params).id} searchParams={await searchParams}/>;}
