// Real Auth + PostgREST + Storage + Next.js + Chromium. Disposable loopback only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(import.meta.url);
const {chromium}=require('../../.qa/browser/node_modules/playwright');
const out='diagnostics/company-e2e';mkdirSync(out,{recursive:true});
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');
assert.equal(new URL(status.API_URL).port,'54321');
assert.ok(status.SERVICE_ROLE_KEY&&status.ANON_KEY,'Disposable local keys required');
const app='http://localhost:3000';
const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:'true',NEXT_PUBLIC_APP_URL:app};
const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:'postgres'};
function sql(query){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',query],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
async function rpc(client,name,args){const r=await client.rpc(name,args);assert.equal(r.error,null,`${name}: ${r.error?.message}`);return r.data;}
const password=`QA-only-${randomUUID()}-Aa9!`,accounts={};
for(const role of ['owner','admin','crm','operator','finance','investor','viewer']){
 const email=`qa-${role}@example.invalid`;
 const result=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:`QA ${role}`}});assert.equal(result.error,null,result.error?.message);
 const id=result.data.user.id,member=randomUUID();
 const t=await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:`QA ${role}`,email,role,roles:[role],active:true,active_status:'active'});assert.equal(t.error,null,t.error?.message);
 const p=await admin.from('profiles').upsert({id,team_member_id:member,full_name:`QA ${role}`,email,role,roles:[role],active_status:'active',must_change_password:false});assert.equal(p.error,null,p.error?.message);
 const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const login=await client.auth.signInWithPassword({email,password});assert.equal(login.error,null,login.error?.message);
 accounts[role]={id,member,email,client,session:login.data.session};
}
const results=[],errors=[];
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',message:String(error.message).slice(0,1500)});throw error;}finally{writeFileSync(`${out}/results.json`,JSON.stringify({results,errors},null,2));}}
function ledger(){return sql(`select jsonb_build_object('transactions',(select count(*) from public.financial_transactions),'movements',(select count(*) from public.inventory_movements),'routes',(select count(*) from public.routes))::text;`);}
const moneyBefore=ledger();
await check('real database role boundaries before browser testing',async()=>{
 for(const role of ['owner','admin','crm','operator','finance']){const d=await rpc(accounts[role].client,'snacky_company_workspace_v1',{});assert.equal(d.manager,['owner','admin'].includes(role));}
 for(const role of ['investor','viewer']){const r=await accounts[role].client.rpc('snacky_company_workspace_v1',{});assert.ok(r.error);}
});
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});writeFileSync('diagnostics/e2e-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Production build failed; see e2e-build.log');
const server=spawn('npm',['run','start','--','--hostname','127.0.0.1'],{env,stdio:['ignore',openSync('diagnostics/e2e-server.log','w'),openSync('diagnostics/e2e-server-errors.log','w')]});
let browser;
try{
 for(let n=0;n<60;n++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(n===59)throw Error('Next server unavailable');}
 browser=await chromium.launch({headless:true});
 const contexts={};
 async function session(role,locale='en',width=1440){
  const context=await browser.newContext({viewport:{width,height:1000},locale:locale==='ar'?'ar-LY':'en-GB'});
  await context.addCookies([{name:'snacky_os_language',value:locale,url:app}]);
  const page=await context.newPage();page.on('pageerror',e=>errors.push({role,message:e.message}));
  await page.goto(app+'/login?next=/company');
  await page.locator('input[name=email]').fill(accounts[role].email);await page.locator('input[name=password]').fill(password);
  await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login'),{timeout:30000}),page.locator('form button[type=submit]').click()]);
  contexts[role]=context;return page;
 }
 async function post(page,path,payload){return page.evaluate(async({path,payload})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};},{path,payload});}
 async function command(page,action,id,revision,version,payload){const req={request_id:randomUUID(),action,item_id:id,revision,version,payload};const result=await post(page,'/api/company/command',req);assert.equal(result.body.ok,true,JSON.stringify(result));return result.body;}
 const owner=await session('owner'),crm=await session('crm','ar',390),operator=await session('operator'),finance=await session('finance');
 await check('actual login and full Company shell for intended staff',async()=>{
  for(const page of [owner,crm,operator,finance]){await page.goto(app+'/company');assert.ok(await page.locator('.company-hub').count());assert.ok(await page.locator('header').count());assert.ok(await page.locator('main').count());}
 });
 let itemId;
 await check('owner can enter a real draft, save, reload and review its exact content',async()=>{
  await owner.goto(app+'/company/new');await owner.locator('form').getByRole('button',{name:'English',exact:true}).click();
  await owner.getByLabel('Title',{exact:true}).fill('QA — Visit a potential location');
  await owner.getByLabel('What is this for?',{exact:true}).fill('A saved, role-scoped acceptance-test guide.');
  await owner.getByLabel('Instructions / responsibilities (plain text)',{exact:true}).fill('When\nBefore visiting a location.\n\nDo\nRecord the outcome and next action.');
  await owner.getByLabel('Next review date',{exact:true}).fill('2027-01-01');
  await owner.getByLabel('Notify these roles about this version',{exact:true}).check();
  await owner.getByLabel('Require explicit acknowledgement of this version',{exact:true}).check();
  await owner.getByRole('button',{name:'Save draft',exact:true}).click();
  await owner.waitForURL(/\/company\/items\/.*draft=1/);itemId=new URL(owner.url()).pathname.split('/').pop();
  await owner.reload();assert.match(await owner.locator('article').innerText(),/Record the outcome/);
  assert.match(await owner.locator('article').innerText(),/Review saved draft before publishing/);
 });
 await check('unpublished drafts are absent from employee search and direct access',async()=>{
  const d=await rpc(accounts.crm.client,'snacky_company_workspace_v1',{p_filters:{section:'guides',q:'QA'}});assert.equal(d.total,0);
  const r=await accounts.crm.client.rpc('snacky_company_workspace_v1',{p_id:itemId});assert.ok(r.error);
  await crm.goto(app+`/company/items/${itemId}?draft=1`);assert.match(crm.url(),/unauthorized/);
 });
 await check('private real file upload remains unavailable until its reviewed publication',async()=>{
  await owner.goto(app+`/company/items/${itemId}?edit=1`);
  const details=owner.locator('details').filter({hasText:'File or editable master'});if(await details.getAttribute('open')===null)await details.locator('summary').click();
  await owner.locator('input[type=file]').setInputFiles({name:'QA-evidence.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n% harmless acceptance fixture\n%%EOF')});
  await owner.getByRole('link',{name:'View attached file',exact:true}).waitFor();
  const fileHref=await owner.getByRole('link',{name:'View attached file',exact:true}).getAttribute('href');
  const hidden=await contexts.crm.request.get(app+fileHref);assert.equal(hidden.status(),404);
  await owner.getByRole('button',{name:'Save draft',exact:true}).click();await owner.waitForURL(/draft=1/);
  owner.once('dialog',d=>d.accept());await owner.getByRole('button',{name:/Publish (reviewed|this|saved|latest)/}).click();
  await owner.waitForURL(url=>url.pathname.includes(itemId)&&!url.searchParams.has('draft'));
  const visible=await contexts.crm.request.get(app+fileHref);assert.equal(visible.status(),200);assert.match((await visible.body()).toString(),/%PDF/);
  assert.match(visible.headers()['cache-control'],/no-store/);assert.equal(visible.headers()['x-content-type-options'],'nosniff');
  assert.equal((await contexts.finance.request.get(app+fileHref)).status(),404);
 });
 let first;
 await check('real published guide, notifications and exact-version acknowledgements persist',async()=>{
  first=await rpc(accounts.crm.client,'snacky_company_workspace_v1',{p_id:itemId});assert.equal(first.record.current_version,1);
  const before=await rpc(accounts.crm.client,'snacky_company_notices_v1',{});assert.equal(before.required_count,1);
  await crm.goto(app+`/company/items/${itemId}`);
  await command(crm,'read',itemId,first.record.revision,1);
  assert.equal((await rpc(accounts.crm.client,'snacky_company_notices_v1',{})).required_count,1);
  await command(crm,'ack',itemId,first.record.revision,1);
  assert.equal((await rpc(accounts.crm.client,'snacky_company_notices_v1',{})).required_count,0);
  await crm.reload();assert.match(await crm.locator('.company-hub').innerText(),/أقررت|acknowledged/);
 });
 await check('concurrent edit, duplicate request and historical/new-version behavior',async()=>{
  const w=await rpc(accounts.owner.client,'snacky_company_workspace_v1',{p_id:itemId});
  const payload={...w.draft,body_en:'Updated current instructions.',body_ar:'التعليمات الحالية المحدّثة.',title_ar:'زيارة موقع محتمل',summary_ar:'دليل اختبار عملي للزيارات والمتابعة.'};
  const request={request_id:randomUUID(),action:'save',item_id:itemId,revision:w.record.revision,payload};
  const [a,b]=await Promise.all([post(owner,'/api/company/command',request),post(owner,'/api/company/command',request)]);assert.deepEqual(a.body,b.body);assert.equal(a.body.ok,true);
  const stale=await post(owner,'/api/company/command',{...request,request_id:randomUUID()});assert.equal(stale.status,409);
  const old=await rpc(accounts.crm.client,'snacky_company_workspace_v1',{p_id:itemId});assert.notEqual(old.record.data.body_en,payload.body_en);
  await command(owner,'publish',itemId,a.body.revision,1);
  assert.equal((await rpc(accounts.crm.client,'snacky_company_notices_v1',{})).required_count,1);
  await crm.goto(app+`/company/items/${itemId}?version=1`);assert.match(await crm.locator('article').innerText(),/نسخة سابقة|Older version/);
  const history=await rpc(accounts.crm.client,'snacky_company_workspace_v1',{p_id:itemId,p_filters:{version:'1'}});assert.match(history.record.data.body_en,/Record the outcome/);
 });
 await check('archive and restore revoke and restore current employee access',async()=>{
  let w=await rpc(accounts.owner.client,'snacky_company_workspace_v1',{p_id:itemId});const archived=await command(owner,'archive',itemId,w.record.revision,2);
  assert.ok((await accounts.crm.client.rpc('snacky_company_workspace_v1',{p_id:itemId})).error);
  assert.equal((await rpc(accounts.crm.client,'snacky_company_notices_v1',{})).attention_count,0);
  await command(owner,'restore',itemId,archived.revision,2);assert.equal((await rpc(accounts.crm.client,'snacky_company_workspace_v1',{p_id:itemId})).record.current_version,2);
 });
 await check('direct API authorization and origin validation do not trust hidden buttons',async()=>{
  const w=await rpc(accounts.owner.client,'snacky_company_workspace_v1',{p_id:itemId});
  const forbidden=await post(crm,'/api/company/command',{request_id:randomUUID(),action:'publish',item_id:itemId,revision:w.record.revision});assert.equal(forbidden.status,403);
  const foreign=await contexts.owner.request.post(app+'/api/company/command',{headers:{origin:'https://other.invalid'},data:{}});assert.equal(foreign.status(),403);
  assert.equal((await contexts.owner.request.get(app+'/api/company/files/not-a-uuid')).status(),404);
  for(const role of ['investor','viewer']){const p=await session(role);await p.goto(app+'/company');assert.match(p.url(),/unauthorized/);}
 });
 await check('inactive linked employee cannot retain Company RPC/file access',async()=>{
  const id=accounts.crm.member;sql(`update public.team_members set active=false,active_status='inactive' where id='${id}'`);
  const r=await accounts.crm.client.rpc('snacky_company_notices_v1',{});assert.ok(r.error,'Inactive team member still has Company access');
  sql(`update public.team_members set active=true,active_status='active' where id='${id}'`);
 });
 await check('full-shell mobile/desktop Arabic and English screenshots have no overflow',async()=>{
  for(const [label,page,path,width] of [['home-ar-390',crm,'/company',390],['guide-ar-390',crm,`/company/items/${itemId}`,390],['library-en-1440',owner,'/company/documents',1440],['editor-en-320',owner,`/company/items/${itemId}?edit=1`,320]]){
   await page.setViewportSize({width,height:950});await page.goto(app+path);await page.locator('.company-hub').waitFor();
   const bad=await page.evaluate(()=>Array.from(document.querySelectorAll('.company-hub *')).filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.right>innerWidth+2||r.left < -2)}).map(e=>e.tagName+':'+e.className));
   assert.deepEqual(bad,[],`${label} horizontal overflow`);
   await page.screenshot({path:`${out}/${label}.png`,fullPage:true});
  }
 });
 await check('Company work does not create inventory, route or financial movements',async()=>{assert.equal(ledger(),moneyBefore);});
 assert.deepEqual(errors,[],'Browser JavaScript errors');
 console.log('PASS: real local Company lifecycle and existing ledger isolation.');
}finally{await browser?.close();server.kill('SIGTERM');writeFileSync(`${out}/results.json`,JSON.stringify({results,errors},null,2));}
