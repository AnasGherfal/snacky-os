import { redirect } from 'next/navigation';
import { CrmWorkspace, type CrmSearchParams } from '@/components/CrmWorkspace';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { uuidPattern } from '@/lib/crm-workspace';
export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
 params: Promise<{ id: string }>; searchParams: Promise<CrmSearchParams>;
}) {
 const { id } = await params;
 const profile = await getCurrentProfile();
 const db = await getAuthenticatedSupabaseServerClient();
 if (profile?.active_status === 'active' && db && uuidPattern.test(id)) {
  // Authorize the old task before revealing or redirecting to its issue.
  // Existing notifications/bookmarks and sale foreign keys remain valid.
  const { data, error } = await db.rpc('snacky_crm_workspace_v1', {
   p_section: 'task', p_id: id, p_filters: {},
  });
  const task = data?.record?.data;
  if (!error && task?.task_type === 'field_action' && uuidPattern.test(String(task.issue_id ?? ''))) {
   redirect(`/issues/${task.issue_id}#field-work`);
  }
 }
 return <CrmWorkspace section="task" id={id} searchParams={await searchParams} />;
}
