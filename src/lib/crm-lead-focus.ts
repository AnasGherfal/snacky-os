import {uuidPattern} from './crm-workspace';

export const leadFocusEnabled = process.env.NEXT_PUBLIC_SNACKY_LEAD_FOCUS_ENABLED !== 'false';
export type FocusSelection={id:string;version:string;focus_revision:number};
export type LeadFocusCommand={request_id:string;action:'set'|'clear';items:FocusSelection[];assigned_to:string|null;until:string|null;next_action:string|null};
export function focusDate(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const d=new Date(value+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;
}
export function focusDefaultEnd(today:string):string {
 if(!focusDate(today))throw Error('invalid');const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+6);return d.toISOString().slice(0,10);
}
export function validateLeadFocusCommand(value:unknown):LeadFocusCommand {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');
 const c=value as LeadFocusCommand;
 if(Object.keys(c).sort().join(',')!=='action,assigned_to,items,next_action,request_id,until'||!uuidPattern.test(c.request_id)||!['set','clear'].includes(c.action)||!Array.isArray(c.items)||c.items.length<1||c.items.length>20)throw Error('invalid');
 for(const x of c.items)if(!x||Object.keys(x).sort().join(',')!=='focus_revision,id,version'||!uuidPattern.test(x.id)||typeof x.version!=='string'||!x.version||x.version.length>80||!Number.isSafeInteger(x.focus_revision)||x.focus_revision<0)throw Error('invalid');
 if(new Set(c.items.map(x=>x.id)).size!==c.items.length)throw Error('invalid');
 if(c.action==='set'){
  if(typeof c.assigned_to!=='string'||!uuidPattern.test(c.assigned_to)||!focusDate(c.until)||(c.next_action!==null&&(typeof c.next_action!=='string'||c.next_action.length>1000)))throw Error('invalid');
 }else if(c.assigned_to!==null||c.until!==null||c.next_action!==null)throw Error('invalid');
 return {...c,items:[...c.items].sort((a,b)=>a.id.localeCompare(b.id))};
}
export function missingLeadFocus(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const e=error as {code?:string;message?:string};
 return ['PGRST202','42883'].includes(e.code??'')&&String(e.message??'').includes('snacky_crm_lead_desk_v1');
}
export function focusMessage(code:string,ar:boolean):string {
 const messages:Record<string,[string,string]>={
  invalid:['Check the employee, selected records and focus date (today to 90 days ahead). Closed places cannot be focused.','راجع الموظف والجهات والموعد (من اليوم إلى 90 يوماً). لا يمكن تركيز الجهات المغلقة.'],
  denied:['Only active management can change focus and assignments.','الإدارة النشطة فقط يمكنها تعديل التركيز والإسناد.'],
  conflict:['A selected record changed. Reload before applying a new selection.','تغير سجل محدد. حمّل أحدث البيانات قبل إعادة الاختيار.'],
  unavailable:['Focus setup is unavailable. Existing lead records remain unchanged.','إعداد التركيز غير متاح. سجلات الجهات الحالية لم تتغير.'],
  uncertain:['Save not confirmed. Retry the same saved request; do not create another selection.','لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه ولا تنشئ اختياراً آخر.'],
 };
 return (messages[code]??messages.uncertain)[ar?1:0];
}
export function confirmedFocusReceipt(command:LeadFocusCommand,response:unknown):boolean {
 if(!response||typeof response!=='object')return false;
 const r=response as {ok?:boolean;request_id?:string;action?:string;count?:number;ids?:string[]};
 return r.ok===true&&r.request_id===command.request_id&&r.action===command.action&&r.count===command.items.length&&Array.isArray(r.ids)
  &&[...r.ids].sort().join(',')===command.items.map(x=>x.id).sort().join(',');
}
