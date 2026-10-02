import {NextResponse} from 'next/server';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {uuidPattern} from '@/lib/crm-workspace';
import type {LeadQuickContext} from '@/lib/crm-lead-quick';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=='active'||!hasAnyRole(profile,['owner','admin','supervisor','crm']))return reply({ok:false,code:'denied'},403);
  if(!uuidPattern.test(id))return reply({ok:false,code:'not_found'},404);
  const db=await getAuthenticatedSupabaseServerClient();if(!db)return reply({ok:false,code:'unavailable'},503);
  const {data,error}=await db.rpc('snacky_crm_workspace_v1',{p_section:'lead',p_id:id,p_filters:{}});
  if(error)return reply({ok:false,code:error.code==='42501'?'denied':'unavailable'},error.code==='42501'?403:503);
  const r=data?.record,d=r?.data;if(!r||r.id!==id||r.kind!=='lead'||!d||typeof d.version!=='string'||!Array.isArray(data.directory))return reply({ok:false,code:'unavailable'},503);
  const text=(value:unknown)=>typeof value==='string'?value:'';
  const people=(data.directory as {id:string;name:string;role:string}[]).filter(p=>p.role!=='operator').map(p=>({id:p.id,name:p.name}));
  const result:LeadQuickContext={userId:profile.id,today:text(data.today),manager:data.manager===true,canEdit:r.can_edit===true&&!r.archived,people:data.manager?people:[],row:{id,title:text(r.title),status:text(r.status),archived:Boolean(r.archived),version:d.version,assignedTo:r.assigned_to||null,assignedName:people.find(p=>p.id===r.assigned_to)?.name||null,nextAction:text(r.next_action),dueDate:text(r.due_date),dueTime:text(r.due_time),notes:text(d.notes),locationId:d.converted_location_id||null,contactName:text(d.contact_person_name),phone:text(d.contact_phone),whatsapp:text(d.contact_whatsapp),email:text(d.contact_email)}};
  return reply({ok:true,context:result});
 }catch{return reply({ok:false,code:'unavailable'},503);}
}
