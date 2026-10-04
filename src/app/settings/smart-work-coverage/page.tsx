import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth';
import { isOwnerAdminRole } from '@/lib/authz';
import { getServerI18n } from '@/lib/i18n/server';
import { loadCoverageSettings } from '@/lib/smart-work-coverage-server';
import CoverageSettingsClient from './CoverageSettingsClient';
export const dynamic='force-dynamic';
export default async function CoverageSettingsPage() {
  const profile=await getCurrentProfile();
  if(!profile) redirect('/login');
  if(profile.active_status!=='active'||profile.must_change_password||!profile.team_member_id||!isOwnerAdminRole(profile)) redirect('/unauthorized');
  const {locale}=await getServerI18n();
  try {return <CoverageSettingsClient initial={await loadCoverageSettings()} ar={locale==='ar'}/>;}
  catch {return <section className="surface-card" dir={locale==='ar'?'rtl':'ltr'} role="alert"><h1 className="text-xl font-bold">{locale==='ar'?'إعدادات التغطية غير متاحة':'Coverage settings unavailable'}</h1><p className="mt-3">{locale==='ar'?'تعذّر تحميل الإعدادات المحفوظة. لم يتم تغيير أي جولة أو مخزون.':'Saved settings could not be loaded. No routes or stock were changed.'}</p></section>;}
}
