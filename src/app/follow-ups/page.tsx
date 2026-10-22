import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth';
import { isOperatorRole, hasAnyRole } from '@/lib/authz';
import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}){const profile=await getCurrentProfile();if(profile&&isOperatorRole(profile)&&!hasAnyRole(profile,['owner','admin','supervisor','crm']))redirect('/operator/issues');return <CrmWorkspace section="task" searchParams={await searchParams}/>;}
