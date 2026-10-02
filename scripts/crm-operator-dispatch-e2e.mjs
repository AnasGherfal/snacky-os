import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';

const url=process.env.API_URL,anon=process.env.ANON_KEY,service=process.env.SERVICE_ROLE_KEY;
assert.ok(url&&anon&&service,'Disposable Supabase environment is required');
assert.equal(new URL(url).hostname,'127.0.0.1');
const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
const password='Local-only-'+randomUUID()+'-A9!';
const people={};

async function makeUser(label,role){
 const email='dispatch-'+label+'@example.invalid';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(created.error);
 const userId=created.data.user.id,memberId=randomUUID();
 assert.ifError((await admin.from('team_members').insert({id:memberId,auth_user_id:userId,full_name:'Dispatch '+label,email,role,roles:[role],active:true,active_status:'active'})).error);
 assert.ifError((await admin.from('profiles').upsert({id:userId,team_member_id:memberId,full_name:'Dispatch '+label,email,role,roles:[role],active_status:'active',must_change_password:false})).error);
 const client=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
 assert.ifError((await client.auth.signInWithPassword({email,password})).error);
 people[label]={userId,memberId,email,client};
}
await makeUser('crm','crm');
await makeUser('operator-a','operator');
await makeUser('operator-b','operator');

const locationId=randomUUID();
assert.ifError((await admin.from('locations').insert({id:locationId,name:'Dispatch QA Location',location_type:'office',status:'active'})).error);
const machineId=randomUUID();
assert.ifError((await admin.from('machines').insert({id:machineId,name:'Dispatch QA Machine',machine_code:'QA-DISPATCH',location_id:locationId,status:'active'})).error);

async function crmCommand(action,id,payload){
 const r=await people.crm.client.rpc('snacky_crm_command_v1',{p_command_id:randomUUID(),p_action:action,p_id:id,p_payload:payload});
 assert.ifError(r.error);return r.data;
}
async function taskRow(id){
 const r=await admin.from('crm_tasks').select('*').eq('id',id).single();assert.ifError(r.error);return r.data;
}
async function issueRow(id){
 const r=await admin.from('issues').select('*').eq('id',id).single();assert.ifError(r.error);return r.data;
}
async function dispatch(person,task,action,note){
 const command={request_id:randomUUID(),task_id:task.id,action,version:task.updated_at,...(note===undefined?{}:{note})};
 const r=await people[person].client.rpc('snacky_issue_dispatch_command_v1',{p_command:command});
 return {r,command};
}

const issue=await crmCommand('issue.save',null,{
 customer_phone:'0910000000',location_id:locationId,machine_id:machineId,
 issue_type:'machine_unavailable',description:'Synthetic dispatch acceptance issue',
 priority:'critical',contact_channel:'whatsapp'
});
const issueId=issue.id;
assert.ok(issueId);

const task=await crmCommand('task.save',null,{
 kind:'issue',related_id:issueId,title:'Restore machine operation',
 task_type:'field_action',assigned_to:people['operator-a'].memberId,
 due_date:new Date().toISOString().slice(0,10),priority:'urgent',
 notes:'Synthetic test only'
});
const taskId=task.id;
let current=await taskRow(taskId);
assert.equal(current.dispatch_state,'assigned');
assert.equal(current.status,'open');
assert.ok(current.ack_due_at);
const ackMinutes=(Date.parse(current.ack_due_at)-Date.parse(current.created_at))/60000;
assert.ok(ackMinutes>=8&&ackMinutes<=12,'urgent acknowledgement target should be about ten minutes');

{
 const other=await dispatch('operator-b',current,'accept');
 assert.equal(other.r.error?.code,'42501');
}
{
 const accepted=await dispatch('operator-a',current,'accept');assert.ifError(accepted.r.error);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'accepted');assert.equal(current.status,'in_progress');assert.ok(current.acknowledged_at);
}
{
 const bypass=await people['operator-a'].client.rpc('snacky_crm_command_v1',{
  p_command_id:randomUUID(),p_action:'task.save',p_id:taskId,
  p_payload:{version:current.updated_at,status:'completed',result:'bypass attempt'}
 });
 assert.equal(bypass.error?.code,'42501');
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'accepted');
}
{
 const onWay=await dispatch('operator-a',current,'en_route');assert.ifError(onWay.r.error);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'en_route');assert.ok(current.en_route_at);
}
{
 const started=await dispatch('operator-a',current,'start');assert.ifError(started.r.error);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'working');assert.ok(current.work_started_at);
}
{
 const blocked=await dispatch('operator-a',current,'block','Power is disconnected at the location');assert.ifError(blocked.r.error);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'blocked');assert.match(current.blocked_reason,/Power is disconnected/);
}
{
 const resumed=await dispatch('operator-a',current,'start');assert.ifError(resumed.r.error);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'working');
}
{
 const noPhoto=await dispatch('operator-a',current,'fix','Restored power and verified machine starts');
 assert.equal(noPhoto.r.error?.code,'23514');
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'working');
}
assert.ifError((await admin.from('crm_documents').insert({
 task_id:taskId,object_path:'qa/'+randomUUID()+'.jpg',original_name:'field-proof.jpg',
 mime_type:'image/jpeg',uploaded_by:people['operator-a'].memberId
})).error);
{
 const fixedCommand={request_id:randomUUID(),task_id:taskId,action:'fix',version:current.updated_at,note:'Restored power and verified vend controls'};
 const first=await people['operator-a'].client.rpc('snacky_issue_dispatch_command_v1',{p_command:fixedCommand});assert.ifError(first.error);
 const replay=await people['operator-a'].client.rpc('snacky_issue_dispatch_command_v1',{p_command:fixedCommand});assert.ifError(replay.error);assert.deepEqual(replay.data,first.data);
 current=await taskRow(taskId);assert.equal(current.dispatch_state,'fixed');assert.equal(current.status,'completed');assert.match(current.result,/Restored power/);
}
let parent=await issueRow(issueId);
assert.notEqual(parent.status,'resolved');
assert.ok(parent.field_completed_at);
assert.match(parent.next_action??'',/Contact customer after field action/i);

{
 const wrongPayload={request_id:randomUUID(),task_id:taskId,action:'accept',version:current.updated_at};
 const first=await people['operator-a'].client.rpc('snacky_issue_dispatch_command_v1',{p_command:wrongPayload});
 assert.equal(first.error?.code,'23514');
}

const fresh=await issueRow(issueId);
const closed=await people.crm.client.rpc('snacky_crm_command_v1',{
 p_command_id:randomUUID(),p_action:'issue.save',p_id:issueId,
 p_payload:{version:fresh.updated_at,status:'resolved',resolution:'Customer confirmed the machine is operating normally'}
});
assert.ifError(closed.error);
parent=await issueRow(issueId);assert.equal(parent.status,'resolved');assert.match(parent.resolution,/Customer confirmed/);

const issue2=await crmCommand('issue.save',null,{
 customer_phone:'0910000001',location_id:locationId,machine_id:machineId,
 issue_type:'screen_keypad',description:'Synthetic reassignment issue',
 priority:'high',contact_channel:'phone'
});
const task2=await crmCommand('task.save',null,{
 kind:'issue',related_id:issue2.id,title:'Check screen and keypad',
 task_type:'field_action',assigned_to:people['operator-a'].memberId,
 due_date:new Date().toISOString().slice(0,10),priority:'high'
});
let second=await taskRow(task2.id);
const accepted2=await dispatch('operator-a',second,'accept');assert.ifError(accepted2.r.error);
second=await taskRow(task2.id);assert.equal(second.dispatch_state,'accepted');
const reassigned=await people.crm.client.rpc('snacky_crm_command_v1',{
 p_command_id:randomUUID(),p_action:'task.save',p_id:second.id,
 p_payload:{version:second.updated_at,assigned_to:people['operator-b'].memberId}
});
assert.ifError(reassigned.error);
second=await taskRow(task2.id);
assert.equal(second.assigned_to,people['operator-b'].memberId);
assert.equal(second.dispatch_state,'assigned');assert.equal(second.status,'open');assert.equal(second.acknowledged_at,null);
const oldAssignee=await dispatch('operator-a',second,'accept');assert.equal(oldAssignee.r.error?.code,'42501');
const newAssignee=await dispatch('operator-b',second,'accept');assert.ifError(newAssignee.r.error);

console.log('CRM operator dispatch acceptance passed');
