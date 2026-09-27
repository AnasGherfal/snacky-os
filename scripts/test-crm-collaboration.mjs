import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const read=p=>fs.readFileSync(p,'utf8');
function load(path,imports={}){const exports={};const code=ts.transpileModule(read(path),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(code,{exports,console,URL,URLSearchParams,Request,AbortSignal,TextDecoder,Uint8Array,require:n=>{assert.ok(n in imports,'Missing mock '+n);return imports[n];}});return exports;}
const lib=load('src/lib/crm-collaboration.ts'),authz=load('src/lib/authz.ts'),body=load('src/lib/company-request.ts');
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const command=()=>({request_id:actor,id,action:'note.create',revision:0,payload:{body:'Owner decision needed',lead_id:null}});
const workspace=()=>({kind:'notes',manager:false,me:actor,rows:[],total:0,pending:0,offset:0,page_size:10,checked_at:'2026-09-27T10:00:00Z'});
function api({roles=['crm'],error=null,result=null,inactive=false,badReceipt=false}={}){
 const calls=[];const db={rpc(name,args){calls.push({name,args});return {abortSignal:()=>Promise.resolve({error,data:result??(name.endsWith('workspace_v1')?workspace():{ok:true,request_id:badReceipt?id:args.p_command.request_id,id:args.p_command.id,action:args.p_command.action,revision:1})})};}};
 const route=load('src/app/api/crm/collaboration/route.ts',{'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200,headers:options.headers})}},'next/cache':{revalidatePath(){}},'@/lib/auth':{getCurrentProfile:async()=>({id:actor,role:roles[0],roles,active_status:inactive?'inactive':'active'}),getAuthenticatedSupabaseServerClient:async()=>db},'@/lib/authz':authz,'@/lib/company-request':body,'@/lib/crm-collaboration':lib});
 return {calls,get:(q='')=>route.GET(new Request('https://snacky.example/api/crm/collaboration'+q)),post:(value=command(),origin='https://snacky.example')=>route.POST(new Request('https://snacky.example/api/crm/collaboration',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)}))};
}
test('CRM-only buying access removed while additive operating roles are retained',()=>{
 const pure={id:actor,role:'crm',roles:['crm'],activeStatus:'active'};
 assert.equal(authz.canAccessPath(pure,'/buying-lists'),false);assert.equal(authz.canAccessPath(pure,'/buying-lists/'+id),false);
 assert.equal(authz.canAccessPath({...pure,roles:['crm','warehouse']},'/buying-lists'),true);
 for(const role of ['owner','admin','operator','warehouse','purchasing','finance'])assert.equal(authz.canAccessPath({id:actor,role,roles:[role]},'/buying-lists'),true);
 for(const role of ['operator','warehouse','supervisor','finance','investor'])assert.equal(authz.canAccessPath({id:actor,role,roles:[role]},'/my-work/notes'),false);
 for(const role of ['owner','admin','crm'])assert.equal(authz.canAccessPath({id:actor,role,roles:[role]},'/my-work/notes'),true);
});
test('new command validates actual body and strict identity before a write',()=>{
 assert.equal(lib.validateCollaborationCommand(command()).payload.body,'Owner decision needed');
 for(const patch of [{request_id:'bad'},{revision:-1},{revision:'1'},{action:'delete'},{impersonate:actor},{payload:{body:'',lead_id:null}},{payload:{body:'x'.repeat(4001),lead_id:null}},{payload:{body:'valid',lead_id:'bad'}}])assert.throws(()=>lib.validateCollaborationCommand({...command(),...patch}));
});
test('labels validate creator-independent selection shape and bounded count',()=>{
 const c={...command(),action:'labels.set',payload:{label_ids:[actor,id]}};assert.doesNotThrow(()=>lib.validateCollaborationCommand(c));
 assert.throws(()=>lib.validateCollaborationCommand({...c,payload:{label_ids:[id,id]}}));assert.throws(()=>lib.validateCollaborationCommand({...c,payload:{label_ids:Array(11).fill(id)}}));
 assert.doesNotThrow(()=>lib.validateCollaborationCommand({...c,payload:{label_ids:[]}}));
});
test('success requires a receipt for the exact request action and record',()=>{
 const c=command(),r={ok:true,request_id:c.request_id,id:c.id,action:c.action,revision:1};assert.equal(lib.validCollaborationReceipt(c,r),true);
 for(const change of [{id:actor},{request_id:id},{action:'note.review'},{ok:false},{revision:'1'},{revision:0}])assert.equal(lib.validCollaborationReceipt(c,{...r,...change}),false);
});
test('malformed workspaces never become false empty or saved state',()=>{
 assert.equal(lib.validateCollaborationWorkspace(workspace()).kind,'notes');
 for(const change of [{me:'bad'},{rows:null},{total:-1},{checked_at:'bad'},{manager:null},{rows:[{id:'bad'}]}])assert.throws(()=>lib.validateCollaborationWorkspace({...workspace(),...change}));
});
test('actual API denies unrelated and inactive roles before database access',async()=>{
 for(const roles of [['operator'],['warehouse'],['finance'],['supervisor'],['investor']]){const h=api({roles});assert.equal((await h.get()).status,403);assert.equal((await h.post()).status,403);assert.equal(h.calls.length,0);}
 const off=api({inactive:true});assert.equal((await off.get()).status,403);assert.equal(off.calls.length,0);
});
test('actual POST rejects foreign origin and malformed or oversized commands',async()=>{
 const h=api();assert.equal((await h.post(command(),'https://evil.example')).status,403);assert.equal((await h.post({...command(),revision:'1'})).status,400);assert.equal((await h.post({...command(),payload:{body:'x'.repeat(25000),lead_id:null}})).status,413);assert.equal(h.calls.length,0);
});
test('actual notes read is scoped through the authenticated RPC and private cache',async()=>{
 const h=api(),r=await h.get('?kind=notes&filter=open&offset=10');assert.equal(r.status,200);assert.equal(h.calls[0].name,'snacky_crm_collaboration_workspace_v1');assert.equal(h.calls[0].args.p_offset,10);assert.equal('user_id' in h.calls[0].args,false);assert.match(r.headers['Cache-Control'],/private, no-store/);
});
test('invalid filters cannot hit database',async()=>{
 for(const q of ['?kind=all','?offset=-1','?offset=1','?id=bad','?filter=secret']){const h=api();assert.equal((await h.get(q)).status,400);assert.equal(h.calls.length,0);}
});
test('actual write maps permission conflict invalid and uncertain outcomes distinctly',async()=>{
 const h=api(),ok=await h.post();assert.equal(ok.status,200);assert.equal(h.calls[0].name,'snacky_crm_collaboration_command_v1');
 for(const [code,status] of [['42501',403],['40001',409],['23505',409],['22023',400],['PGRST202',503],['57014',503]]){const r=await api({error:{code}}).post();assert.equal(r.status,status);assert.equal(r.body.ok,false);assert.equal(r.body.retryable,status===503);}
 assert.equal((await api({badReceipt:true}).post()).status,503);
});
test('missing migration is unavailable rather than empty notes',async()=>{const r=await api({error:{code:'PGRST202'}}).get();assert.equal(r.status,503);assert.equal(r.body.ok,false);});
test('source boundaries leave legacy work commands and management focus intact',()=>{
 const sql=read('supabase/migrations/20260927123856_crm_notes_labels_v1.sql');
 for(const name of ['financial_transactions','inventory_movements','update public.location_pipeline_leads','update public.crm_tasks'])assert.ok(!sql.includes(name));
 assert.match(sql,/crm_collab_private\.labels_for/);assert.match(sql,/revoke all on all tables in schema crm_collab_private/);assert.match(sql,/security invoker/);
 assert.match(read('src/components/CrmManagementNotes.tsx'),/sessionStorage/);assert.match(read('src/components/useCrmCollaborationCommand.ts'),/validCollaborationReceipt/);
});
