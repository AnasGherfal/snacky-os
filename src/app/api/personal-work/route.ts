import {NextResponse} from 'next/server';
import {personalWorkContext} from '@/lib/personal-work-server';
import {isPersonalSection,isPersonalView,loadPersonalSection} from '@/lib/personal-work';
export const dynamic='force-dynamic';
export const maxDuration=20;
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
export async function GET(request:Request){
 const context=await personalWorkContext();
 if(!context.authorized)return json({error:'denied'},403);
 const params=new URL(request.url).searchParams,section=params.get('section'),view=params.get('view')??'active';
 const raw=params.get('offset')??'0',offset=Number(raw);
 // Reject unknown selectors, including user_id / assigned_to / impersonation.
 if([...params.keys()].some(k=>!['section','view','offset'].includes(k))||[...params.keys()].some(k=>params.getAll(k).length!==1)
  ||!isPersonalSection(section)||!isPersonalView(view)||!/^\d+$/.test(raw)||!Number.isSafeInteger(offset)||offset<0||offset>100000||offset%5!==0)return json({error:'invalid'},400);
 const result=await loadPersonalSection(context.read,section,view,offset);
 return json(result,result.status==='unavailable'?503:200);
}
