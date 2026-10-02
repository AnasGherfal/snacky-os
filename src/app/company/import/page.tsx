import { redirect } from 'next/navigation';
import { companySession } from '@/lib/company-server';
import { getServerI18n } from '@/lib/i18n/server';
import { CompanyProposalImport } from '@/components/CompanyProposalImport';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const session = await companySession();
  if (!session?.manager) redirect('/unauthorized');
  const { locale } = await getServerI18n();
  const date = new Date(); date.setUTCDate(date.getUTCDate() + 90);
  return <CompanyProposalImport ar={locale === 'ar'} userId={session.profile.id}
    defaultOwner={session.profile.team_member_id ?? ''} reviewDate={date.toISOString().slice(0,10)}/>;
}
