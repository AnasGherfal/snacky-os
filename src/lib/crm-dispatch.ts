export const crmDispatchActions=['accept','en_route','start','block','fix'] as const;
export type CrmDispatchAction=typeof crmDispatchActions[number];
export type CrmDispatchState='assigned'|'accepted'|'en_route'|'working'|'blocked'|'fixed';
export type CrmDispatchCommand={
  request_id:string;
  task_id:string;
  action:CrmDispatchAction;
  version:string;
  note?:string;
};
export type CrmDispatchTask={
  id:string;
  issue_id:string|null;
  assigned_to:string|null;
  title:string;
  priority:string;
  status:string;
  dispatch_state:CrmDispatchState|null;
  ack_due_at:string|null;
  acknowledged_at:string|null;
  en_route_at:string|null;
  work_started_at:string|null;
  blocked_at:string|null;
  fixed_at:string|null;
  blocked_reason:string|null;
  dispatch_note:string|null;
  result:string|null;
  updated_at:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');return value as Record<string,unknown>;}
export function validateCrmDispatchCommand(value:unknown):CrmDispatchCommand{
 const raw=object(value),request_id=String(raw.request_id??''),task_id=String(raw.task_id??''),action=String(raw.action??'') as CrmDispatchAction,version=String(raw.version??'').trim(),note=raw.note===undefined?undefined:String(raw.note);
 if(!uuid.test(request_id)||!uuid.test(task_id)||!crmDispatchActions.includes(action)||!version||version.length>100)throw Error('invalid');
 if(note!==undefined&&note.length>2000)throw Error('invalid');
 if(['block','fix'].includes(action)&&String(note??'').trim().length<3)throw Error('invalid');
 return {request_id,task_id,action,version,...(note===undefined?{}:{note})};
}
export function crmDispatchSameOrigin(request:Request){const origin=request.headers.get('origin');if(!origin)return true;try{return new URL(origin).origin===new URL(request.url).origin;}catch{return false;}}
export function crmDispatchReceiptMatches(command:CrmDispatchCommand,result:unknown){
 if(!result||typeof result!=='object')return false;
 const row=result as Record<string,unknown>;
 return row.ok===true&&row.request_id===command.request_id&&row.task_id===command.task_id&&row.action===command.action&&typeof row.version==='string';
}
export function crmDispatchError(code:string,ar:boolean){
 const labels:Record<string,[string,string]>={
  denied:['This field action is not assigned to you.','هذا الإجراء الميداني غير مسند لك.'],
  conflict:['This task changed. Reload before continuing.','تغيّرت المهمة. أعد تحميل الصفحة قبل المتابعة.'],
  invalid:['Check the action, note and required field photo.','راجع الإجراء والملاحظة والصورة الميدانية المطلوبة.'],
  uncertain:['The result is uncertain. Retry the saved action before doing anything else.','النتيجة غير مؤكدة. أعد نفس الإجراء المحفوظ قبل أي خطوة أخرى.'],
  unavailable:['Field dispatch is unavailable right now.','الإرسال الميداني غير متاح حالياً.']
 };
 return (labels[code]??labels.unavailable)[ar?1:0];
}
export function crmDispatchLabel(state:string|null|undefined,ar:boolean){
 const labels:Record<string,[string,string]>={
  assigned:['Awaiting acceptance','بانتظار القبول'],
  accepted:['Accepted','تم القبول'],
  en_route:['On the way','في الطريق'],
  working:['Working','قيد العمل'],
  blocked:['Blocked','متوقف'],
  fixed:['Fixed — CRM verification','تم الإصلاح — بانتظار تحقق العلاقات']
 };
 return (labels[state??'']??['Legacy field task','مهمة ميدانية سابقة'])[ar?1:0];
}
export function crmDispatchAckOverdue(task:Pick<CrmDispatchTask,'dispatch_state'|'ack_due_at'>,now=Date.now()){
 return task.dispatch_state==='assigned'&&Boolean(task.ack_due_at)&&Date.parse(String(task.ack_due_at))<now;
}
