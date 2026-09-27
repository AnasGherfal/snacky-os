import {redirect} from 'next/navigation';
import {getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {collaborationRoles,collaborationUuid} from '@/lib/crm-collaboration';
import {CrmManagementNotes} from '@/components/CrmManagementNotes';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const profile=await getCurrentProfile();if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,collaborationRoles))redirect('/unauthorized');
 const {locale}=await getServerI18n(),params=await searchParams,lead=typeof params.lead==='string'&&collaborationUuid.test(params.lead)?params.lead:null;
 return <CrmManagementNotes userId={profile.id} ar={locale==='ar'} leadId={lead}/>;
}
