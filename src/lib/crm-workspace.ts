export type CrmKind = 'lead'|'issue'|'location'|'contact'|'task'|'obligation';
export type CrmSection = CrmKind|'work'|'search'|'management';
export const crmKinds:CrmKind[]=['lead','issue','location','contact','task','obligation'];
export const crmPaths:Record<CrmSection,string>={work:'/my-work',lead:'/locations-pipeline',issue:'/issues',location:'/relationships',contact:'/contacts',task:'/follow-ups',obligation:'/relationships/obligations',search:'/my-work/search',management:'/my-work/team'};
export const crmNames:Record<CrmSection,[string,string]>={work:['My Work','عملي اليوم'],lead:['Leads & Visits','الجهات والزيارات'],issue:['Customer Issues','مشاكل العملاء'],location:['Existing Locations','المواقع الحالية'],contact:['Contacts','جهات الاتصال'],task:['Follow-ups','المتابعات'],obligation:['Location Payments','دفعات المواقع'],search:['Search','البحث'],management:['Team Work','عمل الفريق']};
export const leadStatuses=[['want_to_contact','New','جديد'],['trying_to_reach','Trying to Reach','محاولة تواصل'],['contacted','Contacted','تم التواصل'],['interested','Interested','مهتم'],['visit_scheduled','Meeting Scheduled','موعد محدد'],['offer_sent','Proposal Sent','تم إرسال العرض'],['negotiating','Negotiation','تفاوض'],['accepted','Accepted','مقبول'],['rejected','Not Interested','غير مهتم'],['follow_up_later','Follow Up Later','متابعة لاحقاً']] as const;
export const issueStatuses=[['open','New','جديد'],['in_progress','In Progress','قيد العمل'],['waiting','Waiting','بانتظار إجراء'],['resolved','Resolved','تم الحل']] as const;
export const taskStatuses=[['open','Open','مفتوح'],['in_progress','In Progress','قيد العمل'],['completed','Completed','مكتمل']] as const;
export const issueCategories=[['money_no_product','Money inserted / no product','إدخال نقود دون استلام المنتج'],['product_stuck','Product stuck','منتج عالق'],['wrong_product','Wrong product','منتج خاطئ'],['machine_unavailable','Machine unavailable','الماكينة لا تعمل'],['change_issue','Change issue','مشكلة في الباقي'],['refund_request','Refund request','طلب استرداد'],['product_quality','Product quality','جودة المنتج'],['pricing_issue','Pricing issue','مشكلة سعر'],['other','Other','أخرى']] as const;
export const locationTypes=[['school','School','مدرسة'],['hospital','Hospital / clinic','مستشفى / مصحة'],['university','University','جامعة'],['mall','Mall','مول'],['office','Company / office','شركة / مكتب'],['gym','Gym','نادي رياضي'],['other','Other','أخرى']] as const;
export type CrmOption={value:string;label:string};
export type CrmField={name:string;label:string;type?:'text'|'textarea'|'date'|'time'|'datetime-local'|'number'|'select'|'checkbox'|'email'|'url'|'tel';required?:boolean;value?:string;options?:CrmOption[];advanced?:boolean;hint?:string;max?:number;min?:number;step?:string};
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function crmHref(kind:string,id?:string|null):string {const base=crmPaths[kind as CrmSection]??crmPaths.work;return id&&uuidPattern.test(id)?`${base}/${id}`:base;}
export function crmPhone(value:unknown):string {let digits=String(value??'').replace(/[^0-9]/g,'');if(digits.startsWith('00'))digits=digits.slice(2);if(digits.length===10&&digits.startsWith('0'))digits=`218${digits.slice(1)}`;return digits;}
export function crmContactLink(kind:'phone'|'whatsapp'|'email',value:unknown):string|null {const text=String(value??'').trim();if(!text)return null;if(kind==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)?`mailto:${encodeURIComponent(text)}`:null;const digits=crmPhone(text);return digits.length>=7&&digits.length<=15?(kind==='phone'?`tel:+${digits}`:`https://wa.me/${digits}`):null;}
export function crmStatus(status:string,ar:boolean):string {const row=[...leadStatuses,...issueStatuses,...taskStatuses].find(r=>r[0]===status);if(row)return row[ar?2:1];const legacy:Record<string,[string,string]>={machine_placed:['Active location','موقع فعّال'],meeting_needed:['Meeting needed','يحتاج موعداً'],visited:['Visited','تمت الزيارة'],trial_contract:['Trial / contract','تجربة / عقد'],paid:['Reported paid','مسجّل كمدفوع'],not_applicable:['Not applicable','لا ينطبق'],cancelled:['Cancelled','ملغى'],active:['Active','فعّال'],closed:['Resolved','تم الحل']};return legacy[status]?.[ar?1:0]??status;}
export function crmOptionRows(rows:readonly (readonly [string,string,string])[],ar:boolean):CrmOption[]{return rows.map(row=>({value:row[0],label:row[ar?2:1]}));}
const numericFields=new Set(['estimated_traffic','rent_expectation','amount_involved_lyd','refund_amount_lyd','amount_lyd']);
const nullableFields=new Set(['machine_id','product_id','due_time','next_action_time','next_action_date','happened_at','existing_location_id','related_id','finance_transaction_id',...numericFields]);
export function crmPayload(values:Record<string,string>):Record<string,unknown> {
 const out:Record<string,unknown>={};
 for(const [name,value] of Object.entries(values)){
  if(['__proto__','constructor','prototype'].includes(name))throw new Error('Invalid field');
  if(value.length>4000)throw new Error('A field is too long');
  if(value===''&&nullableFields.has(name)){out[name]=null;continue;}
  if(numericFields.has(name)){const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error('Use a valid non-negative amount');out[name]=n;}
  else if(name==='happened_at'&&value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))throw new Error('Invalid incident time');out[name]=`${value}:00+02:00`;}
  else out[name]=value;
 }
 return out;
}
export function crmOverdue(date:string|null,time:string|null,today:string,clock:string,status:string):boolean {return Boolean(date&&!['completed','resolved','paid','not_applicable','cancelled','rejected','machine_placed'].includes(status)&&(date<today||(date===today&&time!==null&&time<clock)));}
export function crmSameOrigin(request:Request):boolean {const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
