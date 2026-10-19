/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { EmptyState, PageHeader, SecondaryButton, StatusBadge } from '@/components/ui';
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from '@/lib/auth';
import { hasAnyRole, isOperatorRole } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { getServerI18n } from '@/lib/i18n/server';
import { MachineIssueClaimButton } from '@/components/operator/MachineIssueClaimButton';
import { CrmRefresh } from '@/components/CrmClientTools';

export const dynamic = 'force-dynamic';
function when(value: string | null) {
 if (!value) return '—';
 return new Intl.DateTimeFormat('en-GB', {dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Tripoli'}).format(new Date(value));
}
export default async function OperatorIssuesPage({ searchParams }: {
 searchParams: Promise<Record<string,string|string[]|undefined>>;
}) {
 const profile = await getCurrentProfile();
 if (!profile) redirect('/login');
 if (profile.active_status !== 'active' || !hasAnyRole(profile,['operator','owner','admin','supervisor'])) redirect('/unauthorized');
 const { locale } = await getServerI18n();
 const ar = locale === 'ar', tr = (en:string,arabic:string) => ar ? arabic : en;
 const completed = (await searchParams).status === 'completed';
 const admin = getSupabaseAdminClient();
 const db = await getAuthenticatedSupabaseServerClient();
 const memberId = profile.team_member_id;
 // Strictly scope privileged reads to this signed-in person's own field work.
 // No customer contact details, stock costs or other operators' assignments.
 let mine = admin && memberId ? admin.from('crm_tasks')
  .select('id,issue_id,title,priority,status,dispatch_state,created_at,completed_at,result,issue:issues(id,status,description,machine:machines(name,machine_code))')
  .eq('task_type','field_action').eq('assigned_to',memberId).is('archived_at',null)
  .order('created_at',{ascending:false}).limit(100) : null;
 if (mine) mine = completed ? mine.eq('status','completed') : mine.neq('status','completed');
 const {data:myTasks,error:mineError} = mine ? await mine : {data:[],error:null};
 const {data:reported,error:reportedError} = admin && memberId ? await admin.from('issues')
  .select('id,status,priority,description,created_at,machine:machines(name,machine_code)')
  .eq('reported_by',memberId).is('archived_at',null).order('created_at',{ascending:false}).limit(50)
  : {data:[],error:null};
 const {data:available,error:availableError} = db && isOperatorRole(profile) && !completed
  ? await db.rpc('snacky_available_machine_issues_v1') : {data:[],error:null};
 const availableRows = (available ?? []) as Array<{
  task_id:string;issue_id:string;title:string;description:string;priority:string;created_at:string;
  machine_name:string|null;machine_code:string|null;location_name:string|null;distance_from_storage_km:number|string|null;
 }>;
 return <div className="space-y-5" dir={ar?'rtl':'ltr'}>
  <CrmRefresh />
  <PageHeader title={tr('Machine issues','بلاغات الماكينات')}
   subtitle={tr('Claim a fault, open your assigned work, or review a completed repair. Everything opens in the issue itself.','استلم بلاغاً، افتح العمل المسند إليك، أو راجع إصلاحاً مكتملاً. كل العمل داخل البلاغ نفسه.')}
   action={<SecondaryButton href="/operator">{tr('Operator home','الرئيسية للمشغّل')}</SecondaryButton>} />
  <nav className="flex flex-wrap gap-2" aria-label={tr('My issue views','عرض بلاغاتي')}>
   <Link className={!completed?'btn-primary':'btn-secondary'} href="/operator/issues">{tr('Available & my active issues','المتاح وبلاغاتي القائمة')}</Link>
   <Link className={completed?'btn-primary':'btn-secondary'} href="/operator/issues?status=completed">{tr('Completed / repair history','المكتمل / سجل الإصلاحات')}</Link>
  </nav>
  {!completed && isOperatorRole(profile) ? <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
   <h2 className="font-bold text-amber-950">{tr('Available machine issues','أعطال الماكينات المتاحة')}</h2>
   <p className="text-sm text-amber-900">{tr('The first operator to claim takes responsibility. CRM may assign an operator directly instead.','أول مشغّل يستلم البلاغ يصبح مسؤولاً عنه. ويمكن لعلاقات العملاء إسناده مباشرةً.')}</p>
   {availableError ? <p role="alert">{tr('Could not load available issues. Refresh.','تعذر تحميل البلاغات المتاحة. حدّث الصفحة.')}</p>
    : !availableRows.length ? <p className="text-sm">{tr('No unclaimed machine issues at the moment.','لا توجد بلاغات بانتظار الاستلام حالياً.')}</p>
    : availableRows.map(task=><article key={task.task_id} className="space-y-2 rounded-lg border bg-white p-3">
     <div className="flex flex-wrap gap-2"><StatusBadge status={task.priority}/><span className="text-xs text-slate-500">{when(task.created_at)}</span></div>
     <h3 className="font-semibold">{task.machine_name ?? task.title}{task.machine_code?` · ${task.machine_code}`:''}</h3>
     <p className="text-sm text-slate-500">{task.location_name}{task.distance_from_storage_km!=null?` · ${Number(task.distance_from_storage_km).toFixed(1)} km`:''}</p>
     <p className="whitespace-pre-wrap text-sm">{task.description}</p>
     <MachineIssueClaimButton taskId={task.task_id} userId={profile.id}/>
    </article>)}
  </section>:null}
  <section className="space-y-3">
   <h2 className="text-lg font-bold">{completed?tr('My completed repairs','إصلاحاتي المكتملة'):tr('My assigned / claimed issues','بلاغاتي المسندة / المستلمة')}</h2>
   {mineError ? <p role="alert">{tr('Could not load your issue records. Refresh.','تعذر تحميل سجلاتك. حدّث الصفحة.')}</p>
    : !myTasks?.length ? <EmptyState title={tr('No matching issues','لا توجد بلاغات مطابقة')} body={completed?tr('Completed field visits stay here with their repair and sales history.','تظل الزيارات المكتملة هنا مع سجل الإصلاح والمبيعات.'):tr('A claimed or assigned issue will appear here.','تظهر هنا البلاغات التي استلمتها أو أُسندت إليك.')}/>
    : myTasks.map((task:any)=><article key={task.id} className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
     <div className="flex flex-wrap items-center gap-2"><StatusBadge status={task.issue?.status ?? task.status}/><StatusBadge status={task.priority}/></div>
     <h3 className="font-semibold">{task.issue?.machine?.name ?? task.title}</h3>
     <p className="text-sm">{task.title}</p>
     <p className="whitespace-pre-wrap text-sm text-slate-600">{completed?task.result:task.issue?.description}</p>
     <p className="text-xs text-slate-500">{when(completed?task.completed_at:task.created_at)}</p>
     <Link className="btn-primary min-h-11" href={`/issues/${task.issue_id}#field-work`}>{completed?tr('View repair & sales','عرض الإصلاح والمبيعات'):tr('Open issue & work','فتح البلاغ والعمل عليه')}</Link>
    </article>)}
   {(myTasks?.length??0)>=100?<p className="text-xs text-slate-500">{tr('Showing the latest 100 visits.','يظهر أحدث 100 زيارة.')}</p>:null}
  </section>
  {!completed?<section className="space-y-3">
   <h2 className="font-bold">{tr('Issues I reported','بلاغاتي')}</h2>
   {reportedError?<p role="alert">{tr('Could not load your reports.','تعذر تحميل بلاغاتك.')}</p>:!reported?.length?<p className="text-sm text-slate-500">{tr('No reports yet.','لا توجد بلاغات بعد.')}</p>:reported.map((issue:any)=><article key={issue.id} className="space-y-2 rounded-xl border bg-white p-3">
    <StatusBadge status={issue.status}/><h3 className="font-semibold">{issue.machine?.name}</h3>
    <p className="text-sm">{issue.description}</p>
    <Link className="text-sm text-sky-800 underline" href={`/issues/${issue.id}`}>{tr('Open issue','فتح البلاغ')}</Link>
   </article>)}
  </section>:null}
 </div>;
}
