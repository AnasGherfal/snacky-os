// Real Auth / REST / PostgreSQL / browser checks on a disposable loopback backend only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(import.meta.url),{chromium}=require('../.qa/browser/node_modules/playwright');
const AxeBuilder=require('../.qa/browser/node_modules/@axe-core/playwright').default;
const out='diagnostics/buying-sources';mkdirSync(out,{recursive:true});
const cfg=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(x=>x.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(cfg.API_URL).hostname,'127.0.0.1');assert.equal(new URL(cfg.API_URL).port,'54321');
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGPASSWORD:'postgres',PGDATABASE:'postgres'};
function sql(q){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',q],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const accounts={},password=`Only-local-${randomUUID()}-A9!`,app='http://localhost:3000';
for(const role of ['owner','operator','other','warehouse','crm']){
 const actual=role==='other'?'operator':role,email=`store-guidance-${role}@example.invalid`;
 const result=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(result.error);
 const id=result.data.user.id,member=randomUUID();
 assert.ifError((await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:`Guidance ${role}`,email,role:actual,roles:[actual],active:true,active_status:'active'})).error);
 assert.ifError((await admin.from('profiles').upsert({id,team_member_id:member,full_name:`Guidance ${role}`,email,role:actual,roles:[actual],active_status:'active',must_change_password:false})).error);
 const client=createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});assert.ifError((await client.auth.signInWithPassword({email,password})).error);
 accounts[role]={id,member,email,client};
}
const stores=[{id:randomUUID(),name:'Store A — المورد الأول'},{id:randomUUID(),name:'Store B — المورد البديل'},{id:randomUUID(),name:'Store C — بدون سجل'}];
const products=Array.from({length:3},(_,i)=>({id:randomUUID(),sku:`QA-SOURCE-${i}`,name:`Store fixture ${i+1} — منتج تجريبي`,active:true,case_quantity:12,cost_price:99}));
assert.ifError((await admin.from('suppliers').insert(stores)).error);assert.ifError((await admin.from('products').insert(products)).error);
const cases=[['2026-09-01','received','LYD',2,0],['2026-09-02','received','LYD',3,0],['2026-09-03','received','LYD',4,1],['2026-09-04','voided','LYD',91,0],['2026-09-05','draft','LYD',92,0],['2026-09-06','received','USD',93,0]];
for(const [date,status,currency,cost,store] of cases){const id=randomUUID();sql(`insert into public.purchase_orders(id,supplier_id,status,order_date,received_date,currency,voided_at) values('${id}','${stores[store].id}','${status}','${date}','${date}','${currency}',${status==='voided'?"now()":'null'});insert into public.purchase_order_lines(id,purchase_order_id,product_id,ordered_qty,received_qty,unit_cost,unit_cost_lyd,units_per_box,line_position) values('${randomUUID()}','${id}','${products[0].id}',24,24,${cost},${cost},24,1);`);}
const ledgers=()=>sql(`select jsonb_build_object('finance',(select md5(coalesce(jsonb_agg(to_jsonb(f) order by id)::text,'')) from public.financial_transactions f),'inventory',(select md5(coalesce(jsonb_agg(to_jsonb(i) order by id)::text,'')) from public.inventory_movements i),'routes',(select count(*) from public.routes),'purchases',(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.purchase_orders p),'lines',(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.purchase_order_lines p))::text`);
let baseline=ledgers();
const date=sql("select (now() at time zone 'Africa/Tripoli')::date"),listId=randomUUID();
async function workspace(role,id=listId){const r=await accounts[role].client.rpc('snacky_buying_workspace_v1',{p_id:id});assert.ifError(r.error);return r.data;}
async function sources(role,id=listId){const r=await accounts[role].client.rpc('snacky_buying_sources_v1',{p_id:id});assert.ifError(r.error);return r.data;}
async function legacy(role,action,payload={},id=listId){const revision=action==='create'?0:(await workspace(role,id)).record.revision;const r=await accounts[role].client.rpc('snacky_buying_command_v1',{p_command:{request_id:randomUUID(),list_id:id,revision,action,payload}});assert.ifError(r.error);return r.data;}
async function sourceCommand(product=0,primary=0,alternative=1){return {request_id:randomUUID(),list_id:listId,product_id:products[product].id,revision:(await workspace('owner')).record.revision,primary_supplier_id:stores[primary].id,alternative_supplier_id:alternative===null?null:stores[alternative].id,note:'Main entrance branch. Contact management if the price changes.'};}
const save=(role,c)=>accounts[role].client.rpc('snacky_buying_source_save_v1',{p_command:c});
await legacy('owner','create',{title:'Store-guided buying — الشراء حسب المورد',instructions:'Sample order for testing only',assigned_to:accounts.operator.member,due_on:date,items:products.map(p=>({product_id:p.id,boxes:2,units_per_box:12}))});
const results=[],errors=[];let browser,server;
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',message:String(e.message).slice(0,2000)});for(const c of browser?.contexts()??[])for(const p of c.pages())try{await p.screenshot({path:`${out}/failed-${results.length}-${randomUUID().slice(0,6)}.png`,fullPage:true});}catch{}console.error('FAIL '+name+': '+e.message);}finally{writeFileSync(out+'/results.json',JSON.stringify({results,errors},null,2));}}
await check('selected supplier uses its latest received LYD price, not a newer USD/draft/voided or another store',async()=>{
 const c=await sourceCommand(),r=await save('owner',c);assert.ifError(r.error);const s=(await sources('operator')).sources[0];assert.equal(s.primary.unit_cost_lyd,3);assert.equal(s.primary.purchased_on,'2026-09-02');assert.equal(s.alternative.unit_cost_lyd,4);assert.equal(s.primary.historical_units_per_box,24);assert.equal((await workspace('operator')).record.items[0].units_per_box,12);
});
await check('buyer gets only assigned snapshots, without global supplier prices or Finance access',async()=>{
 const s=await sources('operator');assert.deepEqual(s.stores,[]);assert.deepEqual(s.options,[]);assert.equal(s.can_edit,false);
 assert.ok((await accounts.other.client.rpc('snacky_buying_sources_v1',{p_id:listId})).error);
 assert.ok((await accounts.crm.client.rpc('snacky_buying_sources_v1',{p_id:listId})).error);
 for(const role of ['operator','warehouse','crm'])assert.equal((await save(role,await sourceCommand())).error?.code,'42501');
 assert.equal(sql("select has_function_privilege('anon','public.snacky_buying_sources_v1(uuid)','EXECUTE')"),'f');
 assert.equal(sql("select has_function_privilege('authenticated','buying_private.store_price(uuid,uuid)','EXECUTE')"),'f');
 assert.equal(sql("select has_table_privilege('authenticated','buying_private.sources','SELECT')"),'f');
});
await check('source replay and concurrent identical submissions increment once; changed payload is rejected',async()=>{
 const c=await sourceCommand(),r=await Promise.all([save('owner',c),save('owner',c)]);r.forEach(x=>assert.ifError(x.error));assert.deepEqual(r[0].data,r[1].data);assert.equal((await workspace('owner')).record.revision,c.revision+1);assert.equal((await save('owner',{...c,note:'Changed'})).error?.code,'23505');
});
await check('different concurrent store edits cannot overwrite one another',async()=>{
 const c=await sourceCommand(),other={...c,request_id:randomUUID(),primary_supplier_id:stores[2].id,alternative_supplier_id:null};const r=await Promise.all([save('owner',c),save('owner',other)]);assert.equal(r.filter(x=>!x.error).length,1);assert.equal(r.find(x=>x.error).error.code,'40001');assert.ifError((await save('owner',await sourceCommand())).error);
});
await check('missing history is explicitly unknown and does not borrow product cost',async()=>{
 const r=await save('owner',await sourceCommand(1,2,null));assert.ifError(r.error);const s=(await sources('operator')).sources.find(x=>x.product_id===products[1].id);assert.equal(s.primary.unit_cost_lyd,null);assert.equal(s.primary.purchased_on,null);
});
await check('instructions keep their saved reference after purchase history changes',async()=>{
 const before=(await sources('owner')).sources[0];sql(`update public.purchase_order_lines set unit_cost=5,unit_cost_lyd=5 where product_id='${products[0].id}' and unit_cost=3`);const after=(await sources('operator')).sources[0];assert.deepEqual(after,before);baseline=ledgers();
});
await check('an injected audit failure rolls back the source, revision and receipt together',async()=>{
 const c=await sourceCommand(2,0,null),before=(await workspace('owner')).record.revision;
 sql("create function buying_private.qa_source_fail() returns trigger language plpgsql as $$begin raise exception 'Injected local audit failure';end $$;create trigger qa_source_fail before insert on buying_private.source_commands for each row execute function buying_private.qa_source_fail();");
 try{assert.ok((await save('owner',c)).error);assert.equal((await workspace('owner')).record.revision,before);assert.equal((await sources('owner')).sources.some(s=>s.product_id===products[2].id),false);}finally{sql('drop trigger qa_source_fail on buying_private.source_commands;drop function buying_private.qa_source_fail();');}
 assert.ifError((await save('owner',c)).error);assert.equal((await workspace('owner')).record.revision,before+1);
});
await check('inactive accounts lose read and replay access',async()=>{
 sql(`update public.profiles set active_status='inactive' where id='${accounts.operator.id}'`);try{assert.equal((await accounts.operator.client.rpc('snacky_buying_sources_v1',{p_id:listId})).error?.code,'42501');}finally{sql(`update public.profiles set active_status='active' where id='${accounts.operator.id}'`);}
});
const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:cfg.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:cfg.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:cfg.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app};
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:35e6});writeFileSync('diagnostics/buying-sources-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Production build failed');
try{
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{env,stdio:['ignore',openSync('diagnostics/buying-sources-server.log','w'),openSync('diagnostics/buying-sources-errors.log','w')]});
 for(let i=0;i<60;i++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(i===59)throw Error('App unavailable');}
 browser=await chromium.launch({headless:true});
 async function session(role,locale='en',width=1440){const c=await browser.newContext({viewport:{width,height:960}});await c.addCookies([{name:'snacky_os_language',value:locale,url:app}]);const p=await c.newPage();p.setDefaultTimeout(20000);p.setDefaultNavigationTimeout(45000);p.on('pageerror',e=>errors.push(e.message));await p.goto(app+'/login');await p.locator('input[name=email]').fill(accounts[role].email);await p.locator('input[name=password]').fill(password);await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login')),p.locator('form button[type=submit]').click()]);await p.goto(app+'/buying-lists/'+listId);await p.locator('#buying-list-detail').waitFor();return p;}
 const owner=await session('owner'),buyer=await session('operator','ar',390);
 const card=(p,n)=>p.locator('details').filter({has:p.locator('summary strong',{hasText:products[n].name})});
 await check('owner edits store instructions in the existing item; lost response recovers after reload',async()=>{
  const row=card(owner,0);await row.locator(':scope > summary').click();await row.getByText('Edit store instructions',{exact:true}).click();await row.getByRole('textbox',{name:'Exact shop / branch and buying instructions',exact:true}).fill('Use the side entrance — المدخل الجانبي');let request,receipt;
  await owner.route('**/api/buying-lists',async route=>{request=route.request().postDataJSON();const r=await route.fetch();receipt=await r.json();if(receipt.ok)await route.abort('failed');else await route.fulfill({response:r});},{times:1});
  await row.getByRole('button',{name:'Save store instructions',exact:true}).click();await owner.getByText('Save not confirmed. Retry the same saved request.',{exact:true}).waitFor();assert.equal(receipt.ok,true);const version=(await workspace('owner')).record.revision;
  await owner.reload();const wait=owner.waitForResponse(r=>r.url().endsWith('/api/buying-lists')&&r.request().method()==='POST');await owner.getByRole('button',{name:'Retry saved request',exact:true}).click();const retry=await wait;assert.deepEqual(retry.request().postDataJSON(),request);assert.equal((await retry.json()).ok,true);assert.equal((await workspace('owner')).record.revision,version);await owner.reload();
 });
 await check('Arabic buyer sees store groups, unit/box prices and dated alternatives; no owner editor',async()=>{
  await buyer.reload();const row=card(buyer,0);await row.locator(':scope > summary').click();await row.getByText('Use the side entrance — المدخل الجانبي',{exact:true}).waitFor();assert.equal(await buyer.getByRole('button',{name:'حفظ تعليمات المورد',exact:true}).count(),0);assert.ok((await row.innerText()).includes('60.00'));assert.ok((await row.innerText()).includes('2026-09-02'));
  for(const width of [390,320]){await buyer.setViewportSize({width,height:960});assert.ok(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));const scan=await new AxeBuilder({page:buyer}).include('#buying-list-detail').analyze();writeFileSync(`${out}/accessibility-${width}.json`,JSON.stringify(scan.violations,null,2));assert.equal(scan.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);await buyer.screenshot({path:`${out}/buyer-ar-${width}.png`,fullPage:true});}
  await owner.screenshot({path:`${out}/owner-stores.png`,fullPage:true});
 });
 await check('required store instructions and alternatives appear in the existing print view',async()=>{
  await owner.goto(app+'/buying-lists/'+listId+'/print');await owner.locator('[data-buying-print]').waitFor();const text=await owner.locator('[data-buying-print]').innerText();assert.match(text,/Store A/);assert.match(text,/Store B/);assert.match(text,/2026-09-02/);assert.match(text,/Use the side entrance/);await owner.screenshot({path:`${out}/print-preview.png`,fullPage:true});await owner.goto(app+'/buying-lists/'+listId);
 });
 await check('same-origin boundary rejects a cross-site source write and buyer cannot open Finance',async()=>{
  const c=await sourceCommand();const r=await owner.request.post(app+'/api/buying-lists',{headers:{Origin:'https://untrusted.example'},data:{request_id:c.request_id,list_id:c.list_id,action:'source',revision:c.revision,payload:{product_id:c.product_id,primary_supplier_id:c.primary_supplier_id,alternative_supplier_id:c.alternative_supplier_id,note:c.note}}});assert.equal(r.status(),403);await buyer.goto(app+'/finance');await buyer.waitForURL(/\/unauthorized/);await buyer.goto(app+'/buying-lists/'+listId);
 });
 await check('legacy progress still works and completed items cannot have instructions rewritten',async()=>{
  await legacy('operator','item',{product_id:products[0].id,outcome:'bought',bought_boxes:2,note:'Bought from instructed store'});assert.equal((await save('owner',await sourceCommand())).error?.code,'22023');
  for(const n of [1,2])await legacy('operator','item',{product_id:products[n].id,outcome:'unavailable',bought_boxes:0,note:'Not available'});await legacy('operator','complete');assert.equal((await save('owner',await sourceCommand(1,2,null))).error?.code,'22023');assert.equal((await workspace('operator')).record.status,'completed');assert.equal(ledgers(),baseline);
 });
 await check('reassignment removes old source access and permits only the newly assigned CRM buyer',async()=>{
  await legacy('owner','reopen');await legacy('owner','assign',{assigned_to:accounts.crm.member});assert.equal((await accounts.operator.client.rpc('snacky_buying_sources_v1',{p_id:listId})).error?.code,'42501');const s=await sources('crm');assert.equal(s.sources.length,3);assert.deepEqual(s.options,[]);assert.deepEqual(s.stores,[]);assert.equal(ledgers(),baseline);
 });
 await check('new source tables have RLS, no raw grants, and definer helpers are private',async()=>{
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='buying_private' and c.relname in ('sources','source_commands') and c.relrowsecurity"),'2');
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('snacky_buying_sources_v1','snacky_buying_source_save_v1') and p.prosecdef"),'0');assert.equal(ledgers(),baseline);
 });
 assert.deepEqual(errors,[]);assert.equal(results.filter(r=>r.status!=='passed').length,0,'Every store-guidance scenario must pass');
}finally{await browser?.close();server?.kill('SIGTERM');writeFileSync(out+'/results.json',JSON.stringify({results,errors},null,2));}
