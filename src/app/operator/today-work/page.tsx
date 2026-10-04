import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth';
import { canExecuteRoutes } from '@/lib/authz';
import { getRequestLocale } from '@/lib/i18n/server';
import TodayWorkClient from './TodayWorkClient';

export const dynamic = 'force-dynamic';

export default async function TodayWorkPage() {
  const profile=await getCurrentProfile();
  if(!profile) redirect('/login');
  if(profile.active_status!=='active' || !canExecuteRoutes(profile)) redirect('/unauthorized');
  if(profile.must_change_password) redirect('/account');
  const locale=await getRequestLocale();
  return <TodayWorkClient locale={locale} />;
}
