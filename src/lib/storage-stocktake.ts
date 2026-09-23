export const stocktakeUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const stocktakeActions=['create','save','add_product','submit','recount','approve','cancel'] as const;
export type StocktakeAction=typeof stocktakeActions[number];
export type StocktakeCommand={request_id:string;assignment_id:string;action:StocktakeAction;revision:number;payload:Record<string,unknown>};
export type StocktakePerson={id:string;name:string};
export type StocktakeLocation={id:string;name:string};
export type StocktakeRow={id:string;title:string;status:string;revision:number;due_on:string|null;storage_location_id:string;storage_name:string;assigned_to:string;assigned_name:string;created_at:string;submitted_at:string|null;approved_at:string|null;counted_lines:number;total_lines:number};
export type StocktakeRecord=StocktakeRow&{notes:string|null;review_note:string|null};
export type StocktakeLine={product_id:string;name:string;sku:string|null;category:string|null;case_quantity:number;added_during_count:boolean;counted_qty:number|null;counted_at:string|null;baseline_qty?:number;expected_at_count?:number|null;current_qty?:number;variance_delta?:number|null;adjustment_movement_id?:string|null};
export type StocktakeOption={id:string;name:string;sku:string|null;category:string|null;case_quantity:number};
export type StocktakeWorkspace={manager:boolean;today:string;rows:StocktakeRow[];record:StocktakeRecord|null;lines:StocktakeLine[];people:StocktakePerson[];locations:StocktakeLocation[];options:StocktakeOption[]};

function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');
 return value as Record<string,unknown>;
}
function uuid(value:unknown){const text=String(value??'');if(!stocktakeUuid.test(text))throw Error('invalid');return text;}
function integer(value:unknown,min=0){const n=Number(value);if(!Number.isInteger(n)||n<min)throw Error('invalid');return n;}
export function validateStocktakeCommand(value:unknown):StocktakeCommand{
 const raw=object(value), action=String(raw.action??'') as StocktakeAction;
 if(!stocktakeActions.includes(action))throw Error('invalid');
 const payload=object(raw.payload??{});
 const command:StocktakeCommand={request_id:uuid(raw.request_id),assignment_id:uuid(raw.assignment_id),action,revision:integer(raw.revision),payload};
 if(action==='create'){
  uuid(payload.assigned_to);uuid(payload.storage_location_id);
  if(!String(payload.title??'').trim()||String(payload.title).length>160)throw Error('invalid');
 }
 if(action==='save'){
  if(!Array.isArray(payload.counts)||!payload.counts.length)throw Error('invalid');
  for(const row of payload.counts){const item=object(row);uuid(item.product_id);integer(item.counted_qty);}
 }
 if(action==='add_product')uuid(payload.product_id);
 if(['recount','approve','cancel'].includes(action)&&String(payload.note??'').length>2000)throw Error('invalid');
 return command;
}
export function stocktakeSameOrigin(request:Request){
 const origin=request.headers.get('origin');if(!origin)return true;
 try{return new URL(origin).origin===new URL(request.url).origin;}catch{return false;}
}
export function stocktakeReceiptMatches(command:StocktakeCommand,result:unknown){
 if(!result||typeof result!=='object')return false;
 const row=result as Record<string,unknown>;
 return row.ok===true&&row.request_id===command.request_id&&row.assignment_id===command.assignment_id&&row.action===command.action&&Number.isInteger(Number(row.revision));
}
export function stocktakeError(code:string,ar:boolean){
 const labels:Record<string,[string,string]>={
  denied:['Access denied.','غير مسموح لك بهذا الإجراء.'],
  conflict:['This stocktake changed. Reload before continuing.','تغيّر الجرد. أعد تحميل الصفحة قبل المتابعة.'],
  invalid:['Check the count and required fields.','راجع الكميات والحقول المطلوبة.'],
  unavailable:['Stocktake service is unavailable.','خدمة الجرد غير متاحة حالياً.'],
  uncertain:['The result is uncertain. Retry the saved request; do not create a second action.','النتيجة غير مؤكدة. أعد نفس الطلب المحفوظ ولا تنشئ إجراءً جديداً.']
 };
 return (labels[code]??labels.unavailable)[ar?1:0];
}
