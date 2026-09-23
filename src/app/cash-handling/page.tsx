import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { cashHandlingRoles } from '@/lib/cash-handover';
import { CashHandlingWorkspace } from '@/components/CashHandlingWorkspace';
export const dynamic = 'force-dynamic';
export default async function CashHandlingPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || !hasAnyRole(profile, cashHandlingRoles)) redirect('/unauthorized');
  return <CashHandlingWorkspace userId={profile.id} />;
}
