import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read=p=>fs.readFileSync(p,'utf8');
const sql=read('supabase/migrations/20261019160000_issue_owned_field_workspace.sql');
const issue='11111111-1111-4111-8111-111111111111';
const task='22222222-2222-4222-8222-222222222222';
const user='33333333-3333-4333-8333-333333333333';
const pattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function routeHarness(result){
 const calls=[];
 const imports={
  'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  'next/navigation':{redirect:path=>{const e=new Error('redirect');e.path=path;throw e;}},
  '@/components/CrmWorkspace':{CrmWorkspace:'CrmWorkspace'},
  '@/lib/auth':{getCurrentProfile:async()=>({id:user,active_status:'active'}),getAuthenticatedSupabaseServerClient:async()=>({rpc:async(name,args)=>{calls.push({name,args});return result;}})},
  '@/lib/crm-workspace':{uuidPattern:pattern},
 };
 const exports={};
 const output=ts.transpileModule(read('src/app/follow-ups/[id]/page.tsx'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(output,{exports,require:k=>{assert.ok(k in imports,k);return imports[k];}});
 return {run:()=>exports.default({params:Promise.resolve({id:task}),searchParams:Promise.resolve({})}),calls};
}
test('authorized old field-task URL redirects to its issue, preserving old notifications',async()=>{
 const h=routeHarness({data:{record:{data:{task_type:'field_action',issue_id:issue}}},error:null});
 await assert.rejects(h.run(),e=>e.path===`/issues/${issue}#field-work`);
 assert.equal(h.calls[0].name,'snacky_crm_workspace_v1');
 assert.equal(h.calls[0].args.p_id,task);
});
test('ordinary follow-up is not redirected or hidden',async()=>{
 const h=routeHarness({data:{record:{data:{task_type:'follow_up'}}},error:null});
 const r=await h.run();assert.equal(r.props.section,'task');assert.equal(r.props.id,task);
});
test('denied old task lookup never discloses a parent issue redirect',async()=>{
 const h=routeHarness({data:{record:{data:{task_type:'field_action',issue_id:issue}}},error:{code:'42501'}});
 const r=await h.run();assert.equal(r.props.section,'task');
});
test('invalid parent identifier is not used for navigation',async()=>{
 const h=routeHarness({data:{record:{data:{task_type:'field_action',issue_id:'https://wrong.test'}}},error:null});
 const r=await h.run();assert.equal(r.props.section,'task');
});
test('issue contains assigned-operator actions, task-scoped proof and the existing sale form',()=>{
 const s=read('src/components/IssueFieldWork.tsx');
 for(const text of ['snacky_issue_field_workspace_v1','CrmDispatchTaskPanel','CrmDocumentUpload','kind="task"','RepairManualSales','taskId={task.id}','CrmIssueFieldQueueForm','issueId={issueId}'])assert.ok(s.includes(text),text);
 assert.match(s,/task\.status !== 'completed'/);assert.match(s,/task\.dispatch_state === 'available'/);
 assert.doesNotMatch(s,/getSupabaseAdminClient|insert\(|\.delete\(/);
});
test('operator queue includes completed repairs and links directly to parent issues',()=>{
 const s=read('src/app/operator/issues/page.tsx');
 assert.match(s,/status === 'completed'/);
 assert.match(s,/mine\.eq\('status','completed'\)/);
 assert.match(s,/\.eq\('assigned_to',memberId\)/);
 assert.match(s,/\/issues\/\$\{task\.issue_id\}#field-work/);
 assert.match(s,/View repair & sales/);
 assert.doesNotMatch(s,/href=\{`\/follow-ups\//);
});
test('CRM provides explicit machine-not-working and resolved issue views',()=>{
 const s=read('src/app/issues/page.tsx');
 assert.match(s,/type=machine_unavailable/);assert.match(s,/status=resolved/);assert.match(s,/Customer issues & machine faults/);
});
test('follow-up filter excludes field tasks before pagination, not by deleting records',()=>{
 assert.match(sql,/p_section<>''task''/);assert.match(sql,/task_type'',''''\)<>''field_action''/);
 assert.doesNotMatch(sql,/delete from public\.(crm_tasks|issues|route_manual_sales|inventory_movements)|truncate/i);
});
test('assignment reuses available queue task and rejects competing owners',()=>{
 for(const text of ['for update nowait','already_assigned','task.dispatch_state<>\'available\'','Another operator already owns','update public.crm_tasks set assigned_to=v_operator_id','event_kind=\'available\''])assert.ok(sql.includes(text),text);
 assert.match(sql,/public\.snacky_crm_allowed\('issue',p_issue_id,true\)/);
 assert.match(sql,/nullif\(btrim\(issue\.customer_phone\)/);
});
test('read model authorizes issue, constrains operator task scope, denies anonymous execution',()=>{
 assert.match(sql,/public\.snacky_crm_allowed\('issue',p_issue_id,false\)/);
 assert.match(sql,/and \(v_staff or t\.assigned_to=v_me\)/);
 assert.match(sql,/revoke all on function public\.snacky_issue_field_workspace_v1\(uuid\) from public,anon/);
});
test('assignment endpoint rejects foreign origins and revalidates issue and operator queues',()=>{
 const s=read('src/app/api/crm/field-queue/route.ts');
 assert.match(s,/crmSameOrigin\(request\)/);assert.match(s,/uuidPattern\.test\(issueId\)/);
 assert.match(s,/55P03/);assert.match(s,/revalidatePath\(`\/issues\/\$\{issueId\}`\)/);assert.match(s,/revalidatePath\('\/operator\/issues'\)/);
});
