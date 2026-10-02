export const operationSections = ['cash','buying','stocktakes','issues','notifications'] as const;
export type OperationSection = typeof operationSections[number];
export const operationStates = {
 cash_deposit: ['Awaiting storage drop-off','بانتظار وضع النقد في المخزن','Open handover','فتح سجل التسليم'],
 cash_pickup: ['Awaiting pickup','بانتظار استلام النقد','Open handover','فتح سجل التسليم'],
 cash_count: ['Awaiting cash count','بانتظار عد النقد','Open handover','فتح سجل التسليم'],
 cash_reference: ['Earlier record · reference missing','سجل سابق · رقم العلبة غير مسجل','Review earlier record','مراجعة السجل السابق'],
 buying_open: ['Shopping unfinished','الشراء غير مكتمل','Open buying list','فتح قائمة الشراء'],
 buying_exception: ['Partial / unavailable items reported','منتجات ناقصة أو غير متوفرة','Review buying list','مراجعة قائمة الشراء'],
 storage_pending: ['Receipt recorded · storage unconfirmed','فاتورة مسجلة · وضع البضاعة غير مؤكد','Open purchase receipt','فتح فاتورة الشراء'],
 stock_count: ['Physical count outstanding','الجرد الفعلي غير مكتمل','Open stocktake','فتح الجرد'],
 stock_recount: ['Recount requested','مطلوب إعادة الجرد','Open stocktake','فتح الجرد'],
 stock_review: ['Awaiting your approval','بانتظار اعتمادك','Review stocktake','مراجعة الجرد'],
 crm_blocked: ['Field work blocked','العمل الميداني متوقف','Open customer issue','فتح بلاغ العميل'],
 crm_acceptance: ['Acceptance overdue','قبول المهمة متأخر','Contact / reassign','التواصل أو إعادة الإسناد'],
 crm_verify: ['Awaiting CRM verification','بانتظار تحقق علاقات العملاء','Verify customer outcome','التحقق من النتيجة مع العميل'],
 crm_unassigned: ['Issue owner missing','مسؤول البلاغ غير معيّن','Assign issue owner','تعيين مسؤول البلاغ'],
 crm_overdue: ['Issue deadline passed','انتهت مهلة البلاغ','Review issue','مراجعة البلاغ'],
 crm_open: ['Open customer issue','بلاغ عميل مفتوح','Open customer issue','فتح بلاغ العميل'],
 no_device: ['No active device registered','لا يوجد جهاز إشعارات مسجل','Open team account','فتح حساب الموظف'],
 device_registered: ['Active device registered · delivery unverified','جهاز مسجل · وصول الإشعار غير مؤكد','Open team account','فتح حساب الموظف'],
} as const;
export type OperationState = keyof typeof operationStates;
export type OperationRow = {id:string;title:string;context:string|null;person:string|null;state:OperationState;since:string|null;due_at:string|null;href:string};
export type OperationData = {version:1;section:OperationSection;checked_at:string;offset:number;page_size:25;total:number;counts:Partial<Record<OperationState,number>>;rows:OperationRow[];diagnostics?:{notifications_enabled:boolean|null;escalation_enabled:boolean|null;last_scan_at:string|null}};
export type OperationResult = {section:OperationSection;status:'ready';data:OperationData}|{section:OperationSection;status:'unavailable'};
export type OperationReader = (section:OperationSection,offset:number,signal:AbortSignal)=>Promise<unknown>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stateSection:Record<OperationSection,readonly string[]>={cash:['cash_deposit','cash_pickup','cash_count','cash_reference'],buying:['buying_open','buying_exception','storage_pending'],stocktakes:['stock_count','stock_recount','stock_review'],issues:['crm_blocked','crm_acceptance','crm_verify','crm_unassigned','crm_overdue','crm_open'],notifications:['no_device','device_registered']};
export function isOperationSection(value:unknown):value is OperationSection{return typeof value==='string'&&(operationSections as readonly string[]).includes(value);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid overview');return value as Record<string,unknown>;}
function integer(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Invalid count');return value;}
function nullableText(value:unknown):string|null{if(value===null)return null;if(typeof value!=='string'||value.length>10000)throw Error('Invalid text');return value;}
function timestamp(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('Invalid time');return value;}
function validHref(section:OperationSection,href:string){
 const patterns:Record<OperationSection,RegExp>={cash:/^\/(?:cash-handling\?id=|cash-collections\/)([0-9a-f-]+)$/i,buying:/^\/buying-lists\/([0-9a-f-]+)$/i,stocktakes:/^\/inventory\/stocktake\?id=([0-9a-f-]+)$/i,issues:/^\/issues\/([0-9a-f-]+)$/i,notifications:/^\/team\/([0-9a-f-]+)$/i};
 const match=patterns[section].exec(href);return Boolean(match&&uuid.test(match[1]));
}
/** A missing/malformed payload is never converted into an empty queue. */
export function parseOperationData(value:unknown,section:OperationSection,offset=0):OperationData{
 const v=object(value);
 if(v.version!==1||v.section!==section||v.offset!==offset||v.page_size!==25||!Array.isArray(v.rows))throw Error('Invalid section response');
 const total=integer(v.total),counts:Partial<Record<OperationState,number>>={};
 for(const [key,count] of Object.entries(object(v.counts))){if(!stateSection[section].includes(key))throw Error('Invalid state');counts[key as OperationState]=integer(count);}
 if(Object.values(counts).reduce((sum,n)=>sum+(n??0),0)!==total)throw Error('Incomplete counts');
 const rows=v.rows.map(raw=>{
  const r=object(raw);if(typeof r.id!=='string'||!uuid.test(r.id)||typeof r.title!=='string'||r.title.length>10000||typeof r.state!=='string'||!stateSection[section].includes(r.state)||typeof r.href!=='string'||!validHref(section,r.href))throw Error('Invalid row');
  return {id:r.id,title:r.title,context:nullableText(r.context),person:nullableText(r.person),state:r.state as OperationState,since:timestamp(r.since,true),due_at:timestamp(r.due_at,true),href:r.href};
 });
 if(rows.length!==Math.min(25,Math.max(0,total-offset)))throw Error('Incomplete page');
 const data:OperationData={version:1,section,checked_at:timestamp(v.checked_at)!,offset:integer(v.offset),page_size:25,total,counts,rows};
 if(section==='notifications'){
  const d=object(v.diagnostics);for(const key of ['notifications_enabled','escalation_enabled'])if(d[key]!==null&&typeof d[key]!=='boolean')throw Error('Invalid diagnostics');
  data.diagnostics={notifications_enabled:d.notifications_enabled as boolean|null,escalation_enabled:d.escalation_enabled as boolean|null,last_scan_at:timestamp(d.last_scan_at,true)};
 }
 return data;
}
/** Each read has its own deadline; a failed section does not hide other work. */
export async function loadOperationSection(read:OperationReader,section:OperationSection,offset=0,timeoutMs=8000):Promise<OperationResult>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Overview timed out'));},timeoutMs);});
  const raw=await Promise.race([read(section,offset,controller.signal),deadline]);
  return {section,status:'ready',data:parseOperationData(raw,section,offset)};
 }catch{return {section,status:'unavailable'};}finally{if(timer)clearTimeout(timer);}
}
export async function loadOperations(read:OperationReader):Promise<OperationResult[]>{return Promise.all(operationSections.map(section=>loadOperationSection(read,section)));}
export function waitingMinutes(since:string|null,checkedAt:string):number|null{
 if(!since)return null;const n=Math.floor((Date.parse(checkedAt)-Date.parse(since))/60000);return Number.isFinite(n)&&n>=0?n:null;
}
