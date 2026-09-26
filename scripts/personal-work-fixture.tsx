import {PersonalWorkContent} from '@/components/PersonalWorkToday';
import {personalSections,type PersonalResult,type PersonalSection,type PersonalData,type PersonalRow} from '@/lib/personal-work';
const stamp='2026-09-26T12:00:00Z';
const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function row(n:number,title:string,state:PersonalRow['state'],rank:number,actionable=true):PersonalRow{
 return {id:id(n),target_id:id(n),title,context:'Synthetic demo · بيانات تجريبية',state,since:'2026-09-26T09:00:00Z',due_at:null,done:null,total:null,rank,actionable};
}
function data(section:PersonalSection,rows:PersonalRow[],total=rows.length):PersonalData{
 return {version:1,section,view:'active',status:'ready',checked_at:stamp,offset:0,page_size:5,total,actions:rows.filter(r=>r.actionable).length,totals:{active:total,upcoming:0,history:0},rows};
}
export default async function Fixture({searchParams}:{searchParams:Promise<{ar?:string;failure?:string}>}){
 const query=await searchParams;
 const bySection:Record<PersonalSection,PersonalData>={
  cash:{...data('cash',Array.from({length:5},(_,i)=>row(i+1,'Box '+(i+1)+' · علبة نقد',i===0?'cash_count':'cash_pickup',i===0?1:2)),7),actions:7,totals:{active:7,upcoming:0,history:1}},
  buying:data('buying',[{...row(21,'Weekly shopping · مشتريات الأسبوع','buying_shop',4),done:2,total:5,due_at:'2026-09-27T22:00:00Z'}]),
  storage:data('storage',[row(31,'Receipt 42 · فاتورة 42','storage_place',2)]),
  stocktakes:data('stocktakes',[{...row(41,'Main storage count · جرد المخزن','stock_count',5),done:1,total:8},{...row(42,'Submitted count · جرد تم إرساله','stock_wait_review',9,false),done:8,total:8,due_at:'2026-09-24T22:00:00Z'}])
 };
 const initial:PersonalResult[]=personalSections.map(section=>query.failure==='1'&&section==='buying'?{section,view:'active',status:'unavailable'}:{section,view:'active',status:'ready',data:bySection[section]});
 return <main className="mx-auto max-w-5xl p-4 sm:p-6"><PersonalWorkContent ar={query.ar==='1'} name="Demo employee · موظف تجريبي" initial={initial}/></main>;
}
