import {OwnerOperationsOverview} from '@/components/OwnerOperationsOverview';
import {operationSections,type OperationData,type OperationResult,type OperationRow,type OperationSection} from '@/lib/owner-operations';
const checked_at='2026-09-26T12:00:00Z';
const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function row(n:number,title:string,person:string|null,state:OperationRow['state'],href:string):OperationRow{return {id:id(n),title,context:'Synthetic demo · بيانات تجريبية',person,state,since:state==='cash_reference'?null:'2026-09-26T09:00:00Z',due_at:null,href};}
function data(section:OperationSection,rows:OperationRow[]):OperationData{
 const counts:OperationData['counts']={};for(const r of rows)counts[r.state]=(counts[r.state]??0)+1;
 return {version:1,section,checked_at,offset:0,page_size:25,total:rows.length,counts,rows,...(section==='notifications'?{diagnostics:{notifications_enabled:true,escalation_enabled:false,last_scan_at:null}}:{})};
}
export default async function Fixture({searchParams}:{searchParams:Promise<{ar?:string;failure?:string}>}){
 const query=await searchParams;
 const bySection:Record<OperationSection,OperationData>={
  cash:data('cash',[
   row(1,'BOX-014','Demo coordinator · مسؤول تجريبي','cash_count','/cash-handling?id='+id(1)),
   row(2,'BOX-015','Demo operator · مشغّل تجريبي','cash_deposit','/cash-handling?id='+id(2)),
   row(3,'Earlier reference missing',null,'cash_reference','/cash-collections/'+id(3))]),
  buying:data('buying',[row(4,'Weekly shopping · مشتريات الأسبوع','Demo buyer · مسؤول المشتريات','buying_open','/buying-lists/'+id(4)),row(5,'Receipt 42 · فاتورة 42','Demo buyer · مسؤول المشتريات','storage_pending','/buying-lists/'+id(4))]),
  stocktakes:data('stocktakes',[row(6,'Main storage count · جرد المخزن الرئيسي','Demo coordinator · مسؤول تجريبي','stock_review','/inventory/stocktake?id='+id(6))]),
  issues:data('issues',[row(7,'Machine needs visit · ماكينة تحتاج زيارة','Demo operator · مشغّل تجريبي','crm_blocked','/issues/'+id(7)),row(8,'Repair reported complete · إصلاح تم الإبلاغ عنه','Demo CRM · علاقات العملاء','crm_verify','/issues/'+id(8))]),
  notifications:data('notifications',[row(9,'Demo operator · مشغّل تجريبي','Demo operator','no_device','/team/'+id(9)),row(10,'Demo CRM · علاقات العملاء','Demo CRM','device_registered','/team/'+id(10))]),
 };
 const initial:OperationResult[]=operationSections.map(section=>query.failure==='1'&&section==='buying'?{section,status:'unavailable'}:{section,status:'ready',data:bySection[section]});
 return <main className="mx-auto max-w-7xl p-4 sm:p-6"><OwnerOperationsOverview key={query.ar??'en'} initial={initial} ar={query.ar==='1'}/></main>;
}
