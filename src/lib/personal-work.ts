/** Personal work reads only. No commands, balances or employee selector. */
export const personalWorkRoles = ['owner','admin','supervisor','operator','warehouse','purchasing'] as const;
export const personalSections = ['cash','buying','storage','stocktakes'] as const;
export const personalViews = ['active','upcoming','history'] as const;
export type PersonalSection = typeof personalSections[number];
export type PersonalView = typeof personalViews[number];
export const personalStates = {
 cash_count:['Count this box','عد هذه العلبة'],cash_pickup:['Pick up from storage','استلم العلبة من المخزن'],cash_dropoff:['Record storage drop-off','سجّل وضع العلبة في المخزن'],
 cash_wait_dropoff:['Waiting for the collector to deposit','بانتظار إيداع المحصّل للعلبة'],cash_wait_counter:['Waiting for the cash coordinator','بانتظار مسؤول النقد'],
 cash_done:['Cash count recorded','تم تسجيل عد النقد'],cash_voided:['Collection voided','سجل التحصيل ملغى'],
 buying_shop:['Continue shopping','أكمل الشراء'],buying_receipt:['Record purchase receipt','سجّل فاتورة الشراء'],buying_done:['Shopping reported complete','تم إنهاء قائمة الشراء'],buying_cancelled:['Buying list cancelled','قائمة الشراء ملغاة'],
 storage_place:['Confirm goods placed in storage','أكد وضع البضاعة في المخزن'],storage_review:['Contact the owner about this receipt','راجع المالك بخصوص هذه الفاتورة'],storage_done:['Storage placement recorded','تم تسجيل وضع البضاعة في المخزن'],storage_cancelled:['Purchase cancelled','عملية الشراء ملغاة'],
 stock_count:['Count the assigned storage','اجرد المخزن المسند إليك'],stock_recount:['Recount requested','مطلوب إعادة الجرد'],stock_wait_review:['Submitted · waiting for owner review','تم الإرسال · بانتظار مراجعة المالك'],stock_done:['Stockcount approved','تم اعتماد الجرد'],stock_cancelled:['Stockcount cancelled','تم إلغاء الجرد'],
} as const;
export type PersonalState = keyof typeof personalStates;
export type PersonalRow = {id:string;target_id:string;title:string;context:string|null;state:PersonalState;since:string|null;due_at:string|null;done:number|null;total:number|null;rank:number;actionable:boolean};
export type PersonalData = {version:1;section:PersonalSection;view:PersonalView;status:'ready';checked_at:string;offset:number;page_size:5;total:number;actions:number;totals:Record<PersonalView,number>;rows:PersonalRow[]};
export type PersonalResult = {section:PersonalSection;view:PersonalView;status:'ready';data:PersonalData}|{section:PersonalSection;view:PersonalView;status:'restricted'|'unavailable'};
export type PersonalReader = (section:PersonalSection,view:PersonalView,offset:number,signal:AbortSignal)=>Promise<unknown>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed:Record<PersonalSection,readonly string[]>={cash:['cash_count','cash_pickup','cash_dropoff','cash_wait_dropoff','cash_wait_counter','cash_done','cash_voided'],buying:['buying_shop','buying_receipt','buying_done','buying_cancelled'],storage:['storage_place','storage_review','storage_done','storage_cancelled'],stocktakes:['stock_count','stock_recount','stock_wait_review','stock_done','stock_cancelled']};
export function isPersonalSection(v:unknown):v is PersonalSection{return typeof v==='string'&&(personalSections as readonly string[]).includes(v);}
export function isPersonalView(v:unknown):v is PersonalView{return typeof v==='string'&&(personalViews as readonly string[]).includes(v);}
function obj(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid work response');return v as Record<string,unknown>;}
function int(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw Error('Invalid work count');return v;}
function text(v:unknown):string{if(typeof v!=='string'||v.length>10000)throw Error('Invalid text');return v;}
function time(v:unknown):string{if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))throw Error('Invalid timestamp');return v;}
export function personalHref(section:PersonalSection,target:string):string{
 if(!uuid.test(target))throw Error('Invalid work target');
 return section==='cash'?'/cash-handling?id='+target:section==='stocktakes'?'/inventory/stocktake?id='+target:'/buying-lists/'+target;
}
export function parsePersonalResult(raw:unknown,section:PersonalSection,view:PersonalView,offset=0):PersonalResult{
 const v=obj(raw);
 if(v.version!==1||v.section!==section||v.view!==view||v.offset!==offset||v.page_size!==5)throw Error('Wrong work response');
 const checked_at=time(v.checked_at);
 if(v.status==='restricted')return {section,view,status:'restricted'};
 if(v.status!=='ready'||!Array.isArray(v.rows))throw Error('Unavailable work response');
 const t=obj(v.totals),totals={active:int(t.active),upcoming:int(t.upcoming),history:int(t.history)};
 const total=int(v.total),actions=int(v.actions);
 if(total!==totals[view]||actions>total||(view==='history'&&actions!==0))throw Error('Invalid work totals');
 const seen=new Set<string>();
 const rows=v.rows.map(value=>{
  const r=obj(value);
  if(typeof r.id!=='string'||!uuid.test(r.id)||typeof r.target_id!=='string'||!uuid.test(r.target_id)||seen.has(r.id))throw Error('Invalid record');
  seen.add(r.id);
  if(typeof r.state!=='string'||!allowed[section].includes(r.state)||typeof r.actionable!=='boolean')throw Error('Invalid work state');
  const done=r.done===null?null:int(r.done),lineTotal=r.total===null?null:int(r.total);
  if((done===null)!==(lineTotal===null)||(done!==null&&lineTotal!==null&&done>lineTotal))throw Error('Invalid progress');
  return {id:r.id,target_id:r.target_id,title:text(r.title),context:r.context===null?null:text(r.context),state:r.state as PersonalState,since:r.since===null?null:time(r.since),due_at:r.due_at===null?null:time(r.due_at),done,total:lineTotal,rank:int(r.rank),actionable:r.actionable};
 });
 if(rows.length!==Math.min(5,Math.max(0,total-offset))||rows.filter(r=>r.actionable).length>actions)throw Error('Incomplete work page');
 // Whitelist output fields: never forward unexpected money, stock or identity fields.
 return {section,view,status:'ready',data:{version:1,section,view,status:'ready',checked_at,offset:int(v.offset),page_size:5,total,actions,totals,rows}};
}
export async function loadPersonalSection(read:PersonalReader,section:PersonalSection,view:PersonalView='active',offset=0,timeoutMs=8000):Promise<PersonalResult>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Work read timed out'));},timeoutMs);});
  return parsePersonalResult(await Promise.race([read(section,view,offset,controller.signal),deadline]),section,view,offset);
 }catch{return {section,view,status:'unavailable'};}finally{if(timer)clearTimeout(timer);}
}
export function loadPersonalWork(read:PersonalReader,view:PersonalView='active'){return Promise.all(personalSections.map(section=>loadPersonalSection(read,section,view)));}
export function firstWorkSection(results:PersonalResult[]):PersonalSection{
 const candidates=results.flatMap(r=>r.status==='ready'?r.data.rows.filter(x=>x.actionable).map(row=>({section:r.section,row})):[]);
 candidates.sort((a,b)=>a.row.rank-b.row.rank||(Date.parse(a.row.due_at??'9999-01-01')-Date.parse(b.row.due_at??'9999-01-01'))||a.row.id.localeCompare(b.row.id));
 return candidates[0]?.section??results.find(r=>r.status==='ready'&&r.data.total>0)?.section??'cash';
}
export function personalOverdue(row:PersonalRow,data:Pick<PersonalData,'checked_at'|'view'>){return data.view==='active'&&row.actionable&&row.due_at!==null&&Date.parse(row.due_at)<=Date.parse(data.checked_at);}
