/** Recurrence configuration only. Live work remains in crm_tasks. */
export const crmRecurringEnabled = process.env.NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED === 'true';
export const routineId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type RoutineInput = {
  title:string; instructions:string; target_kind:'none'|'lead'|'location'|'issue'|'obligation';
  target_id:string; assigned_to:string; cadence:'days'|'weeks'|'months'; every:number;
  start_on:string; end_on:string; notice_days:number;
};
export type Routine = RoutineInput & {id:string;revision:number;paused:boolean;next_due_on:string;assigned_name:string;target_title:string|null;blocked_reason:string|null;recent_work:{task_id:string;due_on:string;status:string;archived_at:string|null;assigned_name:string|null;skipped_cycles:number}[]|null};
export type RoutineCommand={request_id:string;action:'save'|'pause'|'resume'|'engine.pause'|'engine.resume';id:string;revision:number;payload?:RoutineInput};
export type RoutineData={today:string;rows:Routine[];total:number;offset:number;directory:{id:string;name:string}[];targets:{id:string;kind:RoutineInput['target_kind'];title:string;assigned_to:string|null}[];scheduled:boolean;engine:{enabled:boolean;last_attempt_at:string|null;last_success_at:string|null;last_result:{generated:number;blocked:number;errors:number}|null}};
export function validDate(value:string):boolean {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'2000-01-01'||value>'2100-12-31')return false;
 const date=new Date(value+'T12:00:00Z');return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function validateRoutine(value:unknown):RoutineInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');
 const p=value as RoutineInput;
 const keys=['title','instructions','target_kind','target_id','assigned_to','cadence','every','start_on','end_on','notice_days'];
 if(Object.keys(p).some(k=>!keys.includes(k))||Object.keys(p).length!==keys.length)throw Error('invalid');
 for(const k of ['title','instructions','target_kind','target_id','assigned_to','cadence','start_on','end_on'] as const)if(typeof p[k]!=='string')throw Error('invalid');
 if(!p.title.trim()||p.title.length>240||p.instructions.length>4000||!routineId.test(p.assigned_to))throw Error('invalid');
 if(!['none','lead','location','issue','obligation'].includes(p.target_kind)||(p.target_kind==='none'?p.target_id!=='':!routineId.test(p.target_id)))throw Error('invalid');
 if(!['days','weeks','months'].includes(p.cadence)||!Number.isSafeInteger(p.every)||p.every<1||p.every>365||!Number.isSafeInteger(p.notice_days)||p.notice_days<0||p.notice_days>30)throw Error('invalid');
 if(!validDate(p.start_on)||(p.end_on&&(!validDate(p.end_on)||p.end_on<p.start_on)))throw Error('invalid');
 return {...p,title:p.title.trim(),instructions:p.instructions.trim()};
}
export function validateRoutineCommand(value:unknown):RoutineCommand {
 if(!value||typeof value!=='object')throw Error('invalid');const p=value as RoutineCommand;
 if(!routineId.test(p.id)||!routineId.test(p.request_id)||!Number.isSafeInteger(p.revision)||p.revision<0||!['save','pause','resume','engine.pause','engine.resume'].includes(p.action))throw Error('invalid');
 return {id:p.id,request_id:p.request_id,revision:p.revision,action:p.action,...(p.action==='save'?{payload:validateRoutine(p.payload)}:{})};
}
export function nextRoutineDate(date:string,cadence:RoutineInput['cadence'],every:number,anchor:string):string {
 if(!validDate(date)||!validDate(anchor)||!Number.isInteger(every)||every<1||every>365)throw Error('invalid');
 const d=new Date(date+'T12:00:00Z');
 if(cadence==='days'||cadence==='weeks')d.setUTCDate(d.getUTCDate()+every*(cadence==='weeks'?7:1));
 else if(cadence==='months'){
  const desired=Number(anchor.slice(8,10));d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+every);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(last,desired));
 }else throw Error('invalid');
 return d.toISOString().slice(0,10);
}
export function routinePreview(p:RoutineInput):string[] {
 const dates:string[]=[];if(!validDate(p.start_on))return dates;
 let d=p.start_on;for(let i=0;i<3&&(!p.end_on||d<=p.end_on);i++){dates.push(d);d=nextRoutineDate(d,p.cadence,p.every,p.start_on);}return dates;
}
export const routineFocus = {
 overdue:['Overdue work','العمل المتأخر'],unowned:['Missing owner or next step','مسؤول أو خطوة قادمة غير محددة'],
 waiting:['Waiting: review due','انتظار حان وقت مراجعته'],customer:['Field result: customer follow-up','نتيجة ميدانية تحتاج متابعة العميل'],
 rent:['Location payment follow-up','متابعة دفعات المواقع'],management:['Assigned to management','مسند للإدارة'],
} as const;
export const routineEngineId='00000000-0000-4000-8000-000000000001';
export function routineError(code:string,ar:boolean):string {
 const errors:Record<string,[string,string]>={
 invalid:['Check the schedule fields and dates.','راجع بيانات الجدول والتواريخ.'],
 denied:['An active manager account is required.','يلزم حساب إداري نشط.'],
 conflict:['This record changed. Reload before editing.','تغير السجل. حمّل أحدث نسخة قبل التعديل.'],
 unavailable:['The module is disabled or its database update is missing.','القسم غير مفعّل أو تحديث قاعدة بياناته غير مكتمل.'],
 uncertain:['Save not confirmed. Retry the same request; do not create a duplicate.','لم يتأكد الحفظ. أعد نفس الطلب ولا تنشئ نسخة مكررة.'],
 };return (errors[code]??errors.uncertain)[ar?1:0];
}
