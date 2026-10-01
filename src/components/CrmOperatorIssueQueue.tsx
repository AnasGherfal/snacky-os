import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {CrmDispatchTaskPanel} from '@/components/CrmDispatchPanel';
import type {CrmDispatchTask} from '@/lib/crm-dispatch';

type QueueTask=CrmDispatchTask&{location_name?:string|null;machine_name?:string|null;issue_description?:string|null;issue_type?:string|null;created_at?:string|null};

export async function CrmOperatorIssueQueue(){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['operator']))return null;
 const db=await getAuthenticatedSupabaseServerClient();
 if(!db)return null;
 const {data,error}=await db.rpc('snacky_operator_field_queue_v1',{});
 const {locale}=await getServerI18n(),ar=locale==='ar',tr=(en:string,arabic:string)=>ar?arabic:en;
 if(error){
  console.error('[crm-operator-queue] Could not load available field work',error);
  return <section className="surface-card border border-amber-200"><h2 className="font-semibold">{tr('Available machine issues','مشاكل الماكينات المتاحة')}</h2><p className="mt-2 text-sm text-amber-900">{tr('Could not load the operator claim queue. Reload this page.','تعذر تحميل قائمة البلاغات المتاحة. أعد تحميل الصفحة.')}</p></section>;
 }
 const tasks=Array.isArray(data)?data as QueueTask[]:[];
 if(!tasks.length)return null;
 return <section className="space-y-4">
  <div className="surface-card border border-cyan-200 bg-cyan-50">
   <h2 className="text-lg font-semibold text-cyan-950">{tr('Machine issues available to claim','مشاكل ماكينات متاحة للاستلام')}</h2>
   <p className="mt-1 text-sm text-cyan-900">{tr('These visits were sent to all operators. Claim only a visit you can actually handle; once claimed, it becomes your responsibility.','هذه الزيارات أُرسلت لكل المشغّلين. استلم فقط الزيارة التي تستطيع تنفيذها؛ بعد الاستلام تصبح مسؤوليتك.')}</p>
  </div>
  {tasks.map(task=><article key={task.id} className="rounded-xl border border-slate-200 bg-white p-4">
   <div className="mb-3 grid gap-2 text-sm sm:grid-cols-3">
    <div><span className="text-xs text-slate-500">{tr('Location','الموقع')}</span><p className="font-medium">{task.location_name??'—'}</p></div>
    <div><span className="text-xs text-slate-500">{tr('Machine','الماكينة')}</span><p className="font-medium">{task.machine_name??tr('Not identified','غير محددة')}</p></div>
    <div><span className="text-xs text-slate-500">{tr('Issue','المشكلة')}</span><p className="font-medium">{task.issue_type??'—'}</p></div>
   </div>
   {task.issue_description?<p className="mb-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{task.issue_description}</p>:null}
   <CrmDispatchTaskPanel task={task} userId={profile.id} ar={ar} canAct proofImages={0}/>
  </article>)}
 </section>;
}
