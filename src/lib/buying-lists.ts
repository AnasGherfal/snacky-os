export const buyingRoles = ['owner','admin','supervisor','crm','operator','warehouse','purchasing','finance'] as const;
export const buyingPlannerRoles = ['owner','admin','supervisor','warehouse','purchasing'] as const;
export const buyingUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type BuyingOutcome = 'pending'|'bought'|'partial'|'unavailable';
export type BuyingItem = {product_id:string;name:string;supplier:string|null;units_per_box:number;planned_boxes:number;unit_cost:number|null;outcome:BuyingOutcome;bought_boxes:number;note:string;actual_supplier_id:string|null};
export type BuyingList = {id:string;title:string;instructions:string;assigned_to:string;created_by:string;buyer_name:string;creator_name:string;due_on:string;status:'open'|'completed'|'cancelled';revision:number;created_at:string;updated_at:string;items:BuyingItem[]};
export type BuyingWorkspace = {me:string;planner:boolean;today:string;record:BuyingList|null;people:{id:string;name:string}[];rows:(Omit<BuyingList,'items'> & {item_count:number;checked_count:number})[];total:number;offset:number};
export type BuyingCommand = {request_id:string;list_id:string;action:'create'|'item'|'complete'|'cancel'|'reopen'|'assign'|'source';revision:number;payload:Record<string,unknown>};
export const buyingOutcomeLabels:Record<BuyingOutcome,[string,string]> = {pending:['Not checked','لم يُراجع'],bought:['Bought','تم الشراء'],partial:['Partly bought','تم شراء جزء'],unavailable:['Unavailable','غير متوفر']};
export function buyingDate(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T12:00:00Z');return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');return value as Record<string,unknown>;}
function integer(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw Error('invalid');return v;}
function text(v:unknown,min:number,max:number){if(typeof v!=='string'||v.trim().length<min||v.length>max)throw Error('invalid');return v;}
function id(v:unknown){if(typeof v!=='string'||!buyingUuid.test(v))throw Error('invalid');return v;}
export function validateBuyingCommand(value:unknown):BuyingCommand {
 const c=record(value),p=record(c.payload);id(c.request_id);id(c.list_id);integer(c.revision,0,2147483647);
 if(Object.keys(c).some(k=>!['request_id','list_id','action','revision','payload'].includes(k)))throw Error('invalid');
 switch(c.action){
 case 'create': {
  if(c.revision!==0)throw Error('invalid');text(p.title,1,160);text(p.instructions,0,3000);id(p.assigned_to);if(!buyingDate(p.due_on))throw Error('invalid');
  if(!Array.isArray(p.items)||p.items.length<1||p.items.length>200)throw Error('invalid');const seen=new Set();
  for(const value of p.items){const item=record(value);const product=id(item.product_id);if(seen.has(product))throw Error('invalid');seen.add(product);integer(item.boxes,1,10000);integer(item.units_per_box,2,10000);}
  break;
 }
 case 'item':
  id(p.product_id);integer(p.bought_boxes,0,10000);text(p.note,0,1000);
  if(!Object.hasOwn(buyingOutcomeLabels,String(p.outcome)))throw Error('invalid');
  if(['partial','unavailable'].includes(String(p.outcome))&&!String(p.note).trim())throw Error('reason');
  if(Object.hasOwn(p,'actual_supplier_id')){
   if(['bought','partial'].includes(String(p.outcome)))id(p.actual_supplier_id);
   else if(p.actual_supplier_id!==null)throw Error('invalid');
  }
  break;
 case 'source':
  if(Object.keys(p).length!==4||Object.keys(p).some(k=>!['product_id','primary_supplier_id','alternative_supplier_id','note'].includes(k)))throw Error('invalid');
  id(p.product_id);id(p.primary_supplier_id);if(p.alternative_supplier_id!==null)id(p.alternative_supplier_id);
  if(String(p.primary_supplier_id).toLowerCase()===String(p.alternative_supplier_id).toLowerCase()||c.revision===0)throw Error('invalid');text(p.note,0,1000);break;
 case 'cancel':text(p.reason,1,1000);break;
 case 'assign':id(p.assigned_to);break;
 case 'complete':case 'reopen':break;
 default:throw Error('invalid');
 }
 return c as BuyingCommand;
}
export function buyingReceiptMatches(c:BuyingCommand,value:unknown):boolean {
 if(!value||typeof value!=='object')return false;const r=value as Record<string,unknown>;
 return r.ok===true&&r.request_id===c.request_id&&r.list_id===c.list_id&&r.revision===c.revision+1;
}
export function buyingSameOrigin(request:Request){return request.headers.get('origin')===new URL(request.url).origin&&request.headers.get('sec-fetch-site')!=='cross-site';}
export function buyingTotals(items:BuyingItem[]) {
 return items.reduce((s,i)=>({boxes:s.boxes+i.planned_boxes,units:s.units+i.planned_boxes*i.units_per_box,bought:s.bought+i.bought_boxes,
  checked:s.checked+(i.outcome!=='pending'?1:0),estimate:s.estimate+(i.unit_cost===null?0:Number(i.unit_cost)*i.planned_boxes*i.units_per_box),missing:s.missing+(i.unit_cost===null?1:0)}),{boxes:0,units:0,bought:0,checked:0,estimate:0,missing:0});
}
export function buyingError(code:string,ar:boolean){const messages:Record<string,[string,string]>={
 denied:['Your account cannot access or change this list.','لا يملك حسابك صلاحية الوصول أو التعديل.'],
 conflict:['The list changed on another device. Reload before editing.','تغيرت القائمة على جهاز آخر. حدّثها قبل التعديل.'],
 invalid:['Review the buyer, box sizes, quantities and missing-item explanations. Every item needs an outcome before completion.','راجع المشتري وأحجام الصناديق والكميات وأسباب النقص. يجب مراجعة كل منتج قبل إكمال القائمة.'],
 unavailable:['Shared buying lists could not be loaded. Your local planning list has not been removed.','تعذر تحميل قوائم الشراء المشتركة. لم تُحذف قائمة التخطيط المحلية.'],
 uncertain:['Save not confirmed. Retry the same saved request.','لم يتأكد الحفظ. أعد الطلب المحفوظ نفسه.']};return (messages[code]??messages.invalid)[ar?1:0];}
