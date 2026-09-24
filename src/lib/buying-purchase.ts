export const buyingPurchaseRoles=['owner','admin','supervisor','warehouse','purchasing'] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ReceiptLine={product_id:string;boxes:number;loose:number;line_total_cents:number};
export type ReceiptProof={receipt_sha256:string;receipt_mime:string;receipt_name:string};
export type BuyingReceiptCommand={request_id:string;list_id:string;revision:number;action:'create'|'receive';payload:Record<string,unknown>};
export type ReceiptStore={supplier_id:string;name:string;unit_cost_lyd:number|null;purchased_on:string|null};
export type ReceiptItem={product_id:string;name:string;units_per_box:number;bought_units:number;remaining_units:number;primary:ReceiptStore|null;alternative:ReceiptStore|null};
export type LinkedBuyingReceipt={purchase_id:string;supplier_name:string;receipt_number:string|null;order_date:string;status:string;payment_status:string;total_amount:number;storage_id:string|null;received_at:string|null;received_by:string|null;buyer_id:string;version:string;can_receive:boolean;note:string;lines:{product_id:string;name:string;quantity:number;boxes:number;loose:number;units_per_box:number;line_total_cents:number}[]};
export type BuyingReceiptWorkspace={list_id:string;title:string;revision:number;can_record:boolean;today:string;items:ReceiptItem[];storage:{id:string;name:string}[];receipts:LinkedBuyingReceipt[]};
export function receiptCents(text:string):number{
 if(!/^\d{1,8}(?:\.\d{1,2})?$/.test(text.trim()))throw Error('invalid');
 const [whole,fraction='']=text.trim().split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(cents)||cents<1||cents>1000000000)throw Error('invalid');return cents;
}
export function receiptMoney(cents:number):string{return (cents/100).toFixed(2);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');return value as Record<string,unknown>;}
function exactKeys(o:Record<string,unknown>,keys:string[]){if(Object.keys(o).length!==keys.length||Object.keys(o).some(k=>!keys.includes(k)))throw Error('invalid');}
function id(value:unknown){if(typeof value!=='string'||!uuid.test(value))throw Error('invalid');}
function text(value:unknown,max:number){if(typeof value!=='string'||value.length>max)throw Error('invalid');}
function int(value:unknown,min:number,max:number){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw Error('invalid');}
export function validateBuyingReceiptCommand(value:unknown):BuyingReceiptCommand{
 const c=object(value);exactKeys(c,['request_id','list_id','revision','action','payload']);id(c.request_id);id(c.list_id);int(c.revision,1,2147483646);const p=object(c.payload);
 if(c.action==='create'){
  exactKeys(p,['supplier_id','order_date','receipt_number','lines','storage_id','placed_in_storage','note','receipt_sha256','receipt_mime','receipt_name']);
  id(p.supplier_id);text(p.order_date,10);const date=String(p.order_date);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw Error('invalid');
  text(p.receipt_number,100);text(p.note,2000);text(p.receipt_name,200);if(!String(p.receipt_name).trim())throw Error('invalid');
  if(typeof p.placed_in_storage!=='boolean')throw Error('invalid');
  if(p.storage_id!==null)id(p.storage_id);if(p.placed_in_storage&&!p.storage_id)throw Error('invalid');
  if(typeof p.receipt_sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.receipt_sha256))throw Error('invalid');
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(String(p.receipt_mime)))throw Error('invalid');
  if(!Array.isArray(p.lines)||p.lines.length<1||p.lines.length>200)throw Error('invalid');const seen=new Set<string>();
  for(const entry of p.lines){const line=object(entry);exactKeys(line,['product_id','boxes','loose','line_total_cents']);id(line.product_id);int(line.boxes,0,10000);int(line.loose,0,9999);int(line.line_total_cents,1,1000000000);
   if(seen.has(String(line.product_id))||Number(line.boxes)+Number(line.loose)===0)throw Error('invalid');seen.add(String(line.product_id));}
 }else if(c.action==='receive'){
  exactKeys(p,['purchase_id','version','storage_id','confirmed']);id(p.purchase_id);id(p.storage_id);text(p.version,100);if(!p.version||!Number.isFinite(Date.parse(String(p.version)))||p.confirmed!==true)throw Error('invalid');
 }else throw Error('invalid');
 return c as BuyingReceiptCommand;
}
export function buyingReceiptResultMatches(command:BuyingReceiptCommand,value:unknown){
 if(!value||typeof value!=='object')return false;const r=value as Record<string,unknown>;
 return r.ok===true&&r.request_id===command.request_id&&r.list_id===command.list_id&&r.action===command.action&&r.revision===command.revision+1&&typeof r.purchase_id==='string'&&uuid.test(r.purchase_id)&&['draft','received'].includes(String(r.status));
}
export function receiptFileExtension(mime:string){return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'} as Record<string,string>)[mime]??null;}
export function receiptFileMatches(bytes:Uint8Array,mime:string){
 const is=(offset:number,signature:number[])=>signature.every((b,i)=>bytes[offset+i]===b);
 if(mime==='image/jpeg')return is(0,[255,216,255]);
 if(mime==='image/png')return is(0,[137,80,78,71,13,10,26,10]);
 if(mime==='application/pdf')return is(0,[37,80,68,70,45]);
 if(mime==='image/webp')return is(0,[82,73,70,70])&&is(8,[87,69,66,80]);return false;
}
export function buyingReceiptError(code:string,ar:boolean){const messages:Record<string,[string,string]>={
 denied:['Only the assigned purchasing/storage employee can save this receipt. No Finance role is required.','الحفظ للمسؤول عن الشراء والمخزن المسند للقائمة. لا تحتاج صلاحية المالية.'],
 conflict:['The list or purchase changed, or this receipt is already recorded. Reload and open the existing receipt before retrying.','تغيّرت القائمة أو الفاتورة، أو سبق تسجيل هذا الإيصال. حدّث الصفحة وراجع الفاتورة الموجودة.'],
 invalid:['Check bought quantities, approved store, actual prices, price-increase note and receipt file. Nothing was posted by this rejected request.','راجع الكميات المشتراة والمورد المعتمد والأسعار الفعلية وسبب زيادة السعر والإيصال. لم يُسجل الطلب المرفوض.'],
 unavailable:['Purchase recording is not available. The existing buying checklist remains usable.','تسجيل الفواتير غير متاح حالياً. تبقى قائمة الشراء الحالية متاحة.'],
 uncertain:['The save result is unknown. Retry the same saved request; do not enter a second receipt.','نتيجة الحفظ غير مؤكدة. أعد نفس الطلب المحفوظ ولا تسجل فاتورة ثانية.'],
 corrupt:['A saved request cannot be read. Review existing receipts before clearing browser data. New saves are blocked to avoid duplicates.','تعذر قراءة طلب محفوظ. راجع الفواتير قبل مسح بيانات المتصفح. أوقفنا الحفظ الجديد لمنع التكرار.']};return (messages[code]??messages.unavailable)[ar?1:0];}
