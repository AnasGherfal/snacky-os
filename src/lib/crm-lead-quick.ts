import {leadStatuses,uuidPattern,crmStatus} from './crm-workspace';
export const quickModes=['log','next','stage','contact','assign'] as const;
export type LeadQuickMode=typeof quickModes[number];
export const quickLabels:Record<LeadQuickMode,[string,string]>={log:['Log contact','تسجيل تواصل'],next:['Next step','الخطوة القادمة'],stage:['Change stage','تغيير المرحلة'],contact:['Contact details','بيانات التواصل'],assign:['Assign','إسناد']};
export type LeadQuickContext={userId:string;today:string;manager:boolean;canEdit:boolean;row:{id:string;title:string;status:string;archived:boolean;version:string;assignedTo:string|null;assignedName:string|null;nextAction:string;dueDate:string;dueTime:string;notes:string;locationId:string|null;contactName:string;phone:string;whatsapp:string;email:string};people:{id:string;name:string}[]};
export type LeadQuickRequest={id:string;action:'lead.save'|'note.add';recordId:string;values:Record<string,string>};
export type SavedLeadQuick={mode:LeadQuickMode;request:LeadQuickRequest};
export function leadIsClosed(status:string){return status==='rejected'||status==='machine_placed';}
export function quickDefaults(mode:LeadQuickMode,c:LeadQuickContext):Record<string,string>{const r=c.row;if(mode==='log')return {activity_type:'call',summary:''};if(mode==='next')return {next_action:r.nextAction,next_action_date:r.dueDate||c.today};if(mode==='stage')return {status:r.status,reason:'',confirm:''};if(mode==='contact')return {contact_person_name:r.contactName,contact_phone:r.phone,contact_whatsapp:r.whatsapp,contact_email:r.email};return {assigned_to:r.assignedTo||''};}
function validDay(value:string){const d=new Date(value+'T12:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;}
/** One existing audited command, not a second writer or a sequence of partial saves. */
export function buildLeadQuick(mode:LeadQuickMode,c:LeadQuickContext,input:Record<string,string>,id:string):LeadQuickRequest{
 if(!uuidPattern.test(id)||!c.canEdit||c.row.archived||!uuidPattern.test(c.row.id))throw Error('denied');
 const v=Object.fromEntries(Object.entries(input).map(([k,value])=>[k,value.trim()]));if(Object.values(v).some(value=>value.length>4000))throw Error('too_long');
 let values:Record<string,string>={version:c.row.version};let action:LeadQuickRequest['action']='lead.save';
 if(mode==='log'){if(!['call','whatsapp','email','visit','meeting','proposal','note'].includes(v.activity_type)||!v.summary)throw Error('required');action='note.add';values={kind:'lead',activity_type:v.activity_type,summary:v.summary};}
 else if(mode==='next'){if(leadIsClosed(c.row.status))throw Error('closed');if(!v.next_action||!validDay(v.next_action_date))throw Error('required');values={...values,next_action:v.next_action,next_action_date:v.next_action_date};}
 else if(mode==='stage'){
  if(!leadStatuses.some(s=>s[0]===v.status)&&!(v.status==='machine_placed'&&c.row.locationId))throw Error('stage');if(v.status===c.row.status)throw Error('no_change');if(!v.reason)throw Error('reason');
  if((leadIsClosed(v.status)||leadIsClosed(c.row.status)||v.status==='accepted')&&v.confirm!=='true')throw Error('confirm');
  const note=`${c.today} · ${crmStatus(c.row.status,false)} → ${crmStatus(v.status,false)}\n${v.reason}`;const notes=[c.row.notes,note].filter(Boolean).join('\n\n');if(notes.length>4000)throw Error('notes_full');values={...values,status:v.status,notes};
 }else if(mode==='contact'){if(v.contact_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contact_email))throw Error('email');for(const field of ['contact_person_name','contact_phone','contact_whatsapp','contact_email'])values[field]=v[field]||'';}
 else if(mode==='assign'){if(!c.manager||!c.people.some(p=>p.id===v.assigned_to))throw Error('denied');values={...values,assigned_to:v.assigned_to};}else throw Error('mode');
 return {id,action,recordId:c.row.id,values};
}
export function readLeadQuick(raw:string,leadId:string):SavedLeadQuick{
 const s=JSON.parse(raw) as SavedLeadQuick,r=s?.request;if(!quickModes.includes(s?.mode)||!r||!uuidPattern.test(r.id)||r.recordId!==leadId||!r.values||Array.isArray(r.values)||Object.values(r.values).some(v=>typeof v!=='string'||v.length>4000))throw Error('saved_request');
 const allowed:Record<LeadQuickMode,string[]>={log:['kind','activity_type','summary'],next:['version','next_action','next_action_date'],stage:['version','status','notes'],contact:['version','contact_person_name','contact_phone','contact_whatsapp','contact_email'],assign:['version','assigned_to']};
 if(r.action!==(s.mode==='log'?'note.add':'lead.save')||Object.keys(r.values).some(k=>!allowed[s.mode].includes(k))||allowed[s.mode].some(k=>typeof r.values[k]!=='string')||(s.mode==='log'&&r.values.kind!=='lead'))throw Error('saved_request');return s;
}
export function quickReceiptMatches(r:LeadQuickRequest,value:unknown):boolean{if(!value||typeof value!=='object')return false;const v=value as Record<string,unknown>;return v.ok===true&&v.id===r.recordId&&v.commandId===r.id&&v.kind==='lead';}
