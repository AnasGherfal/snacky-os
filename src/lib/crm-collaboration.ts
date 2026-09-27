export const collaborationRoles=['owner','admin','crm'] as const;
export const labelColors=['blue','green','amber','rose','purple','slate'] as const;
export type LabelColor=typeof labelColors[number];
export type CrmLabel={id:string;name:string;color:LabelColor;owner_id:string;owner_name:string;revision?:number};
export type ManagementNote={id:string;author_id:string;author_name:string;body:string;lead_id:string|null;lead_name:string|null;status:'open'|'seen'|'done';response:string;reviewer_name:string|null;revision:number;created_at:string;updated_at:string};
export type NotesWorkspace={kind:'notes';manager:boolean;me:string;rows:ManagementNote[];total:number;pending:number;offset:number;page_size:number;checked_at:string};
export type LabelsWorkspace={kind:'labels';manager:boolean;me:string;options:CrmLabel[];selected:CrmLabel[];lead_id:string|null;revision:number;can_edit:boolean;checked_at:string};
export type CollaborationCommand={request_id:string;id:string;action:'note.create'|'note.review'|'label.create'|'label.update'|'labels.set';revision:number;payload:Record<string,unknown>};
export const collaborationUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('invalid');return v as Record<string,unknown>;}
function text(v:unknown,min:number,max:number){if(typeof v!=='string'||v.trim().length<min||v.length>max)throw Error('invalid');return v;}
export function validateCollaborationCommand(v:unknown):CollaborationCommand{
 const r=record(v),p=record(r.payload),action=r.action as CollaborationCommand['action'];
 if(Object.keys(r).sort().join(',')!=='action,id,payload,request_id,revision'||!collaborationUuid.test(String(r.id))||!collaborationUuid.test(String(r.request_id))||!Number.isSafeInteger(r.revision)||Number(r.revision)<0)throw Error('invalid');
 if(action==='note.create'){text(p.body,1,4000);if(p.lead_id!==null&&!collaborationUuid.test(String(p.lead_id)))throw Error('invalid');}
 else if(action==='note.review'){text(p.response,0,4000);if(!['open','seen','done'].includes(String(p.status)))throw Error('invalid');}
 else if(action==='label.create'||action==='label.update'){text(p.name,1,40);if(!labelColors.includes(p.color as LabelColor)||action==='label.update'&&typeof p.archived!=='boolean')throw Error('invalid');}
 else if(action==='labels.set'){if(!Array.isArray(p.label_ids)||p.label_ids.length>10||p.label_ids.some(x=>!collaborationUuid.test(String(x)))||new Set(p.label_ids).size!==p.label_ids.length)throw Error('invalid');}
 else throw Error('invalid');
 return {request_id:String(r.request_id),id:String(r.id),action,revision:Number(r.revision),payload:p};
}
export function validCollaborationReceipt(c:CollaborationCommand,v:unknown):boolean{
 if(!v||typeof v!=='object')return false;const r=v as Record<string,unknown>;
 return r.ok===true&&r.request_id===c.request_id&&r.id===c.id&&r.action===c.action&&Number.isSafeInteger(r.revision)&&Number(r.revision)>0;
}
export function validateCollaborationWorkspace(v:unknown):NotesWorkspace|LabelsWorkspace{
 const r=record(v);if(typeof r.manager!=='boolean'||!collaborationUuid.test(String(r.me))||typeof r.checked_at!=='string'||!Number.isFinite(Date.parse(r.checked_at)))throw Error('unavailable');
 const validLabel=(v:unknown)=>{const l=record(v);return collaborationUuid.test(String(l.id))&&collaborationUuid.test(String(l.owner_id))&&typeof l.name==='string'&&typeof l.owner_name==='string'&&labelColors.includes(l.color as LabelColor);};
 if(r.kind==='labels'){
  if(!Array.isArray(r.options)||!Array.isArray(r.selected)||!r.options.every(validLabel)||!r.selected.every(validLabel)||!Number.isSafeInteger(r.revision)||typeof r.can_edit!=='boolean')throw Error('unavailable');
 }else if(r.kind==='notes'){
  if(!Array.isArray(r.rows)||r.rows.length>10||!Number.isSafeInteger(r.total)||!Number.isSafeInteger(r.pending)||!Number.isSafeInteger(r.offset)||Number(r.total)<r.rows.length)throw Error('unavailable');
  for(const v of r.rows){const n=record(v);if(!collaborationUuid.test(String(n.id))||typeof n.body!=='string'||typeof n.response!=='string'||typeof n.author_name!=='string'||!Number.isSafeInteger(n.revision)||!['open','seen','done'].includes(String(n.status)))throw Error('unavailable');}
 }else throw Error('unavailable');
 return r as unknown as NotesWorkspace|LabelsWorkspace;
}
export function collaborationMessage(code:string,ar:boolean){
 const m:Record<string,[string,string]>={invalid:['Check the note or label fields.','راجع حقول الملاحظة أو التصنيف.'],denied:['You no longer have access to this action.','لم تعد لديك صلاحية لهذا الإجراء.'],conflict:['This record changed. Reload before saving again.','تغيّر السجل. حدّثه قبل الحفظ مرة أخرى.'],unavailable:['Could not load. Your saved records have not been cleared.','تعذر التحميل. لم تُحذف سجلاتك المحفوظة.'],uncertain:['Save not confirmed. Retry the same saved request.','لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه.']};
 return (m[code]??m.unavailable)[ar?1:0];
}
