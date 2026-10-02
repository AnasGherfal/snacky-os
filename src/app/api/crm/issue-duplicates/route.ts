import {NextResponse} from 'next/server';
import {getAuthenticatedSupabaseServerClient,getCurrentProfile} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {uuidPattern} from '@/lib/crm-workspace';

export const dynamic='force-dynamic';

const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});

export async function GET(request:Request){
 const profile=await getCurrentProfile();
 if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return json({ok:false},403);
 const url=new URL(request.url);
 const locationId=String(url.searchParams.get('location_id')??'');
 const machineId=String(url.searchParams.get('machine_id')??'');
 const issueType=String(url.searchParams.get('issue_type')??'').trim().slice(0,80);
 if(!uuidPattern.test(locationId)||!issueType)return json({ok:true,duplicates:[],repeat_count_30d:0});
 if(machineId&&!uuidPattern.test(machineId))return json({ok:false},400);
 const db=await getAuthenticatedSupabaseServerClient();if(!db)return json({ok:false},503);

 const since24=new Date(Date.now()-24*60*60*1000).toISOString();
 let duplicateQuery=db.from('issues')
  .select('id,issue_type,description,created_at,status,machine_id,location_id,machine:machines(name,machine_code)')
  .eq('location_id',locationId)
  .eq('issue_type',issueType)
  .is('archived_at',null)
  .eq('is_practice',false)
  .not('status','in','(resolved,closed)')
  .gte('created_at',since24)
  .order('created_at',{ascending:false})
  .limit(3);
 if(machineId)duplicateQuery=duplicateQuery.eq('machine_id',machineId);
 const duplicateResult=await duplicateQuery;
 if(duplicateResult.error)return json({ok:false},503);

 let repeatCount=0;
 if(machineId){
  const since30=new Date(Date.now()-30*24*60*60*1000).toISOString();
  const repeatResult=await db.from('issues')
   .select('id',{count:'exact',head:true})
   .eq('machine_id',machineId)
   .eq('issue_type',issueType)
   .is('archived_at',null)
   .eq('is_practice',false)
   .gte('created_at',since30);
  if(!repeatResult.error)repeatCount=repeatResult.count??0;
 }
 return json({ok:true,duplicates:duplicateResult.data??[],repeat_count_30d:repeatCount});
}
