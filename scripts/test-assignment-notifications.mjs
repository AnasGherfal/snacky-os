import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
function load(path,imports={},globals={}){
 const exports={};const source=ts.transpileModule(read(path),{compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,URL,Buffer,Date,Promise,console:{warn(){},info(){},error(){}},...globals,require(name){assert.ok(name in imports,'Unexpected import '+name);return imports[name];}});return exports;
}
function fixture(outcomes=['accepted','temporary','expired','skip']){
 const claims=outcomes.map(()=>({id:crypto.randomUUID(),lease_id:crypto.randomUUID()}));
 const finishes=[],sent=[];
 const db={async rpc(name,args){
  if(name==='snacky_claim_notification_deliveries_v1')return {data:claims,error:null};
  if(name==='snacky_notification_delivery_payload_v1'){
   const i=claims.findIndex(c=>c.id===args.p_id&&c.lease_id===args.p_lease);
   assert.notEqual(i,-1);return {data:outcomes[i]==='skip'?null:{subscription:{id:claims[i].id},payload:{notificationId:claims[i].id,url:'/my-work'},outcome:outcomes[i]},error:null};
  }
  if(name==='snacky_finish_notification_delivery_v1'){finishes.push(args);return {data:true,error:null};}
  throw Error('Unexpected RPC '+name);
 }};
 const send=async(_db,packet)=>{sent.push(packet);return packet.outcome==='accepted'?{sent:true}:{sent:false,statusCode:packet.outcome==='expired'?410:503,reason:'push_provider_unavailable'};};
 const {dispatchWorkNotifications}=load('src/lib/work-notification-dispatch.ts',{'server-only':{},'@/lib/notification-delivery':{sendWorkNotification:send}});
 return {db,claims,finishes,sent,run:()=>dispatchWorkNotifications(db)};
}
test('each device receives its own result; successful phones do not retry with a failed phone',async()=>{
 const f=fixture();const result=await f.run();assert.deepEqual(JSON.parse(JSON.stringify(result)),{attempted:4,accepted:1,failed:2,skipped:1});
 assert.deepEqual(f.claims.map(c=>f.finishes.find(x=>x.p_id===c.id)?.p_result),['accepted','retry','failed','skipped']);
 assert.equal(f.sent.length,3);assert.equal(f.sent[0].payload.notificationId,f.claims[0].id);
});
test('worker refuses invalid or unavailable claims without sending anything',async()=>{
 for(const response of [{error:{},data:null},{error:null,data:null},{error:null,data:[{id:'bad',lease_id:'bad'}]}]){
  const f=fixture();f.db.rpc=async()=>response;await assert.rejects(f.run());assert.equal(f.sent.length,0);
 }
});
test('current eligibility is fetched immediately before delivery; skipped assignments never reach push',async()=>{
 const f=fixture(['skip','accepted']);await f.run();assert.equal(f.sent.length,1);assert.equal(f.finishes.find(x=>x.p_id===f.claims[0].id).p_result,'skipped');
});
test('an unconfirmed receipt fails rather than falsely claiming a delivered notification',async()=>{
 const f=fixture(['accepted']);const rpc=f.db.rpc;f.db.rpc=async(name,args)=>name==='snacky_finish_notification_delivery_v1'?{data:false,error:null}:rpc(name,args);
 await assert.rejects(f.run(),/receipt_unconfirmed/);
});
test('source-load errors remain retryable and cannot turn into success',async()=>{
 const f=fixture(['accepted']);const rpc=f.db.rpc;f.db.rpc=async(name,args)=>name==='snacky_notification_delivery_payload_v1'?{error:{},data:null}:rpc(name,args);
 const result=await f.run();assert.equal(result.accepted,0);assert.equal(f.sent.length,0);assert.equal(f.finishes[0].p_result,'retry');
});
function endpoint({db=true,authorized=true,enabled=true,rpcError=false,dispatchError=false}={}){
 let sends=0,checks=0;
 const api=load('src/app/api/notifications/dispatch/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200})}},
  '@/lib/supabase-server':{getSupabaseAdminClient:()=>db?{async rpc(name,args){checks++;assert.equal(name,'snacky_notification_worker_start_v1');assert.match(args.p_token,/^[a-f0-9]{64}$/);return {data:{authorized,enabled},error:rpcError?{}:null};}}:null},
  '@/lib/work-notification-dispatch':{dispatchWorkNotifications:async()=>{sends++;if(dispatchError)throw Error();return {accepted:1};}},
 });return {...api,counts:()=>({sends,checks})};
}
const req=(authorization)=>new Request('https://snacky-os.vercel.app/api/notifications/dispatch',{method:'POST',headers:authorization?{authorization}:{},body:'{"user_id":"attacker","message":"ignored"}'});
test('dispatcher is not an anonymous or user-session mass-notification endpoint',async()=>{
 for(const auth of [undefined,'Bearer bad','Basic a','Bearer '+('A'.repeat(64))]){const f=endpoint();assert.equal((await f.POST(req(auth))).status,401);assert.equal(f.counts().sends,0);assert.equal(f.counts().checks,0);}
 const f=endpoint({authorized:false});assert.equal((await f.POST(req('Bearer '+('b'.repeat(64))))).status,401);assert.equal(f.counts().sends,0);
});
test('private scheduler handshake activates only through a verified token and honors pause',async()=>{
 const paused=endpoint({enabled:false});assert.equal((await paused.POST(req('Bearer '+('a'.repeat(64))))).body.paused,true);assert.equal(paused.counts().sends,0);
 const f=endpoint();assert.equal((await f.POST(req('Bearer '+('a'.repeat(64))))).body.accepted,1);assert.equal(f.counts().sends,1);assert.equal(f.maxDuration,60);
});
test('server and dispatch errors are retryable failures, not success responses',async()=>{
 for(const options of [{db:false},{rpcError:true},{dispatchError:true}]){const f=endpoint(options);assert.equal((await f.POST(req('Bearer '+('a'.repeat(64))))).status,503);}
});
test('legacy route sender does not duplicate active outbox alerts or fall back on transient mode errors',async()=>{
 for(const mode of [{data:true,error:null},{data:null,error:{code:'PGRST000'}}]){
  let reads=0;const db={rpc:async()=>mode,from(){reads++;throw Error('Legacy sender should not execute');}};
  const api=load('src/lib/notification-delivery.ts',{'server-only':{},'web-push':{default:{}},'node:crypto':crypto,'@/lib/supabase-server':{getSupabaseAdminClient:()=>db},'@/lib/push-subscription':{}});
  const result=await api.notifyRouteAssigned(db,{routeId:'route',routeDate:'2026-09-20',operatorTeamMemberId:'team'});assert.equal(reads,0);assert.ok(result.handledByOutbox||result.reason==='notification_mode_unavailable');
 }
});
test('worker click destinations cover every connected assignment type without allowing other origins',async()=>{
 const callbacks={};const opened=[];const shown=[];const worker={location:{origin:'https://os.test'},addEventListener:(name,fn)=>callbacks[name]=fn,registration:{showNotification:async(t,options)=>shown.push(options)},clients:{matchAll:async()=>[],openWindow:async(url)=>opened.push(url)}};
 vm.runInNewContext(read('public/sw.js'),{self:worker,URL,console});
 for(const url of ['/locations-pipeline/x','/relationships/x','/relationships/obligations/x','/follow-ups/x','/issues/x','/my-work','/company/items/x','/operator/routes/x','https://evil.test/leak']){
  let done;callbacks.notificationclick({notification:{close(){},data:{url}},waitUntil:p=>done=p});await done;assert.equal(opened.at(-1),'https://os.test'+(url.startsWith('https:')?'/account':url));
 }
 const notificationId=crypto.randomUUID();let done;callbacks.push({data:{json:()=>({notificationId,title:'Assigned',url:'/my-work'})},waitUntil:p=>done=p});await done;assert.equal(shown[0].tag,'work:'+notificationId);assert.equal(shown[0].renotify,false);
});
test('coverage stays on existing assignment records and a private persisted outbox',()=>{
 const sql=read('supabase/migrations/20260919220000_assignment_notifications.sql');
 for(const relation of ['routes','location_pipeline_leads','issues','crm_tasks','location_relationships','location_admin_obligations','routines','operator_instructions','company_private.items'])assert.ok(sql.includes(relation));
 assert.match(sql,/for update skip locked/);assert.match(sql,/attempts>=5/);assert.match(sql,/is_practice/);assert.match(sql,/event_key/);assert.match(sql,/activated_at is not null/);
 const scheduler=read('supabase/migrations/20260919220100_assignment_notification_scheduler.sql');assert.match(scheduler,/vault\.create_secret/);assert.match(scheduler,/\* \* \* \* \*/);assert.match(scheduler,/net.http_post/);
 assert.doesNotMatch(scheduler,/Bearer [a-f0-9]{64}/);assert.doesNotMatch(sql,/insert into public\.(routes|issues|crm_tasks|financial_transactions|inventory_movements)/i);
});
