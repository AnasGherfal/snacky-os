import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import DailyDutiesClient from './DailyDutiesClient';
export const dynamic='force-dynamic';
export default async function DailyDutiesPage(){
  const p=await getCurrentProfile();
  if(!p) redirect('/login');
  if(p.active_status!=='active'||p.must_change_password||!canExecuteRoutes(p)) redirect('/unauthorized');
  const {locale}=await getServerI18n();return <DailyDutiesClient ar={locale==='ar'}/>;
}
