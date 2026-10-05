import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { redirect } from 'next/navigation';
import ProductPlanClient from './ProductPlanClient';
export const dynamic='force-dynamic';
export default async function ProductPlanPage(){
  const profile=await getCurrentProfile();
  if(!profile || profile.active_status!=='active' || profile.must_change_password || !canExecuteRoutes(profile))redirect('/unauthorized');
  const {locale}=await getServerI18n();
  return <ProductPlanClient ar={locale==='ar'}/>;
}
