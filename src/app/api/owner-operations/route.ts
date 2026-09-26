import {NextResponse} from 'next/server';
import {ownerOperationsContext} from '@/lib/owner-operations-server';
import {isOperationSection,loadOperationSection,loadOperations} from '@/lib/owner-operations';
export const dynamic='force-dynamic';
export const maxDuration=30;
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
export async function GET(request:Request){
 const context=await ownerOperationsContext();
 if(!context.authorized)return json({error:'denied'},403);
 const params=new URL(request.url).searchParams,section=params.get('section');
 if(!section){if(params.has('offset'))return json({error:'invalid'},400);return json({version:1,sections:await loadOperations(context.read)});}
 const raw=params.get('offset')??'0',offset=Number(raw);
 if(!isOperationSection(section)||!/^\d+$/.test(raw)||!Number.isSafeInteger(offset)||offset<0||offset>100000||offset%25!==0)return json({error:'invalid'},400);
 return json(await loadOperationSection(context.read,section,offset));
}
