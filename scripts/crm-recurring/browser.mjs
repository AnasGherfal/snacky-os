// Full-stack acceptance: loopback-only real Supabase and production Next.js.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(import.meta.url);
const {chromium}=require('../../.qa/browser/node_modules/playwright');
const AxeBuilder=require('../../.qa/browser/node_modules/@axe-core/playwright').default;
const out='diagnostics/recurring-browser';mkdirSync(out,{recursive:true});
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');assert.equal(new URL(status.API_URL).port,'54321');
assert.ok(status.ANON_KEY&&status.SERVICE_ROLE_KEY);
const app='http://localhost:3000',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app,NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED:'true'};
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:'postgres'};
function sql(q){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',q],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),accounts={};
const password=`Isolated-${randomUUID()}-A9!`;
for(const role of ['owner','crm','operator']){
 const email=`recurrence-${role}@example.invalid`,u=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(u.error);
 const id=u.data.user.id,member=randomUUID();
 assert.ifError((await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:`Fixture ${role}`,email,role,roles:[role],active:true,active_status:'active'})).error);
 assert.ifError((await admin.from('profiles').upsert({id,team_member_id:member,full_name:`Fixture ${role}`,email,role,roles:[role],active_status:'active',must_change_password:false})).error);
 const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});assert.ifError((await client.auth.signInWithPassword({email,password})).error);accounts[role]={email,id,member,client};
}
async function rpc(role,name,args={}){const r=await accounts[role].client.rpc(name,args);assert.ifError(r.error);return r.data;}
const ledger=()=>sql("select jsonb_build_object('finance',(select count(*) from public.financial_transactions),'stock',(select count(*) from public.inventory_movements),'routes',(select count(*) from public.routes))::text");
const baseline=ledger(),results=[],errors=[];let browser,server;
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',message:String(e.message).slice(0,2000)});let n=0;for(const c of browser?.contexts()??[])for(const p of c.pages())try{await p.screenshot({path:`${out}/failure-${++n}.png`,fullPage:true});}catch{}throw e;}finally{writeFileSync(out+'/results.json',JSON.stringify({results,errors},null,2));}}
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});writeFileSync('diagnostics/recurring-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Recurring enabled build failed');
try{
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{env,stdio:['ignore',openSync('diagnostics/recurring-server.log','w'),openSync('diagnostics/recurring-server-errors.log','w')]});
 for(let i=0;i<60;i++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(i===59)throw Error('Server unavailable');}
 browser=await chromium.launch({headless:true});
 async function session(role,locale='en',width=1440){const context=await browser.newContext({viewport:{width,height:1000}});await context.addCookies([{name:'snacky_os_language',value:locale,url:app}]);const p=await context.newPage();p.on('pageerror',e=>errors.push({role,message:e.message}));await p.goto(app+'/login');await p.locator('input[name=email]').fill(accounts[role].email);await p.locator('input[name=password]').fill(password);await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:30000}),p.locator('form button[type=submit]').click()]);return p;}
 const owner=await session('owner'),crm=await session('crm'),operator=await session('operator');
 const path='/my-work/team/routines';
 const post=(page,body)=>page.evaluate(async body=>{const r=await fetch('/api/crm/routines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},body);
 await check('real sign-in, guarded pages and disabled engine',async()=>{
  await owner.goto(app+path);await owner.getByText('Generation paused',{exact:true}).waitFor();
  assert.match(await owner.locator('main').innerText(),/Automatic scheduler is not configured/);
  for(const p of [crm,operator]){await p.goto(app+path);await p.waitForURL(/\/unauthorized/);}
  for(const role of ['crm','operator'])assert.ok((await accounts[role].client.rpc('snacky_crm_routines_v1',{})).error);
  assert.equal(JSON.parse(sql('select crm_automation_private.tick()')).disabled,true);
 });
 let id;
 await check('real editor save with response loss and reload keeps exactly one routine',async()=>{
  await owner.goto(app+path+'?new=1');
  await owner.waitForURL(u=>/^[0-9a-f-]{36}$/.test(u.searchParams.get('id')??''));
  id=new URL(owner.url()).searchParams.get('id');assert.ok(id);
  await owner.getByLabel('Responsibility',{exact:true}).fill('Daily customer relationship follow-up');
  await owner.getByLabel('Responsible employee',{exact:true}).selectOption(accounts.crm.member);
  await owner.getByLabel('Period',{exact:true}).selectOption('days');
  await owner.getByLabel('Instructions / expected result',{exact:true}).fill('Review current contacts and record the next action. Test data only.');
  await owner.route('**/api/crm/routines',async route=>{await route.fetch();await route.abort('failed');},{times:1});
  await owner.getByRole('button',{name:'Save routine',exact:true}).click();await owner.getByRole('button',{name:'Retry saved request',exact:true}).waitFor();
  let w=await rpc('owner','snacky_crm_routines_v1');assert.equal(w.total,1);assert.equal(w.rows[0].revision,1);assert.equal(w.rows[0].paused,true);
  await owner.reload();await owner.getByRole('button',{name:'Retry saved request',exact:true}).click();await owner.getByRole('button',{name:'Saved',exact:true}).waitFor();
  w=await rpc('owner','snacky_crm_routines_v1');assert.equal(w.total,1);assert.equal(w.rows[0].revision,1);
 });
 await check('explicit UI activation, real pg_cron configuration and one native task',async()=>{
  sql(readFileSync('scripts/crm-recurring/install-job.sql','utf8'));
  await owner.goto(app+path);await owner.getByText('Automatic scheduler configured.',{exact:true}).waitFor();
  owner.once('dialog',d=>d.accept());await owner.getByRole('button',{name:'Activate',exact:true}).click();
  await owner.getByRole('button',{name:'Pause',exact:true}).waitFor();
  owner.once('dialog',d=>d.accept());await owner.getByRole('button',{name:'Enable generation',exact:true}).click();await owner.getByText('Generation enabled',{exact:true}).waitFor();
  sql('select crm_automation_private.tick()');sql('select crm_automation_private.tick()');
  // A real cron tick may coincide with explicit generation; only one committed occurrence is allowed.
  for(let n=0;n<20&&sql('select count(*) from crm_automation_private.occurrences')==='0';n++)await new Promise(r=>setTimeout(r,100));
  assert.equal(sql('select count(*) from crm_automation_private.occurrences'),'1');
 });
 await check('concurrent worker lock prevents overlapping generation',async()=>{
  const held=spawn('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',"begin; select pg_advisory_xact_lock(hashtextextended('snacky-crm-recurring-worker',0)); select pg_sleep(2); commit;"],{env:pg,stdio:'ignore'});
  let seen=false;for(let n=0;n<30;n++){if(sql("select exists(select 1 from pg_stat_activity where query like '%pg_sleep(2)%' and wait_event='PgSleep')")==='t'){seen=true;break;}await new Promise(r=>setTimeout(r,30));}assert.ok(seen,'Worker lock fixture not acquired');
  assert.equal(JSON.parse(sql('select crm_automation_private.tick()')).busy,true);
  await new Promise(resolve=>{held.once('exit',resolve);if(held.exitCode!==null)resolve();});
  assert.equal(sql('select count(*) from crm_automation_private.occurrences'),'1');
 });
 let task;
 await check('employee sees and completes generated work through the existing UI',async()=>{
  const w=await rpc('crm','snacky_crm_workspace_v1',{p_section:'work',p_filters:{scope:'mine',window:'today'}});assert.equal(w.total,1);task=w.rows[0].id;
  await crm.goto(app+'/follow-ups/'+task);await crm.getByLabel('Status',{exact:true}).selectOption('completed');await crm.getByLabel('Work performed / result',{exact:true}).fill('Reviewed contacts and recorded the next step.');
  await crm.getByRole('button',{name:'Save changes',exact:true}).click();await crm.getByText('Reviewed contacts and recorded the next step.',{exact:true}).first().waitFor();
  assert.equal((await rpc('crm','snacky_crm_workspace_v1',{p_section:'task',p_id:task})).record.status,'completed');
 });
 await check('catch-up does not flood or rewrite existing work',async()=>{
  const r=JSON.parse(sql("select crm_automation_private.tick(clock_timestamp()+interval '4 days')"));assert.equal(r.generated,1);
  assert.equal(sql('select count(*) from crm_automation_private.occurrences'),'2');
  assert.equal(sql('select skipped_cycles from crm_automation_private.occurrences order by due_on desc limit 1'),'3');
  sql("select crm_automation_private.tick(clock_timestamp()+interval '8 days')");assert.equal(sql('select count(*) from crm_automation_private.occurrences'),'2');
  assert.equal(sql("select count(*) from public.crm_tasks where status='completed'"),'1');
 });
 await check('management shows actual completions and existing record links',async()=>{
  const w=await rpc('owner','snacky_crm_management_v2',{p_filters:{days:'1'}});assert.equal(w.metrics.tasks_completed,1);
  await owner.goto(app+'/my-work/team');await owner.getByRole('heading',{name:'Customer Relations — Management',exact:true}).waitFor();
  await owner.getByRole('link',{name:'Recurring responsibilities',exact:true}).waitFor();assert.ok(await owner.locator('a[href^="/follow-ups/"]').count());
 });
 await check('direct API permissions and origin checks remain enforced',async()=>{
  const payload={request_id:randomUUID(),action:'pause',id,revision:2};
  assert.equal((await post(crm,payload)).status,403);
  assert.equal((await owner.context().request.post(app+'/api/crm/routines',{headers:{origin:'https://other.invalid'},data:payload})).status(),403);
  assert.equal((await post(owner,{...payload,revision:0})).status,409);
  assert.equal((await post(owner,{padding:'x'.repeat(40000)})).status,413);
  assert.ok((await accounts.crm.client.rpc('snacky_crm_routine_command_v1',{p_request_id:randomUUID(),p_action:'pause',p_id:id,p_revision:2,p_payload:{}})).error);
 });
 await check('pause retains tasks and historical completion',async()=>{
  await owner.goto(app+path);owner.once('dialog',d=>d.accept());await owner.getByRole('button',{name:'Pause',exact:true}).click();await owner.getByRole('button',{name:'Activate',exact:true}).waitFor();
  sql("select crm_automation_private.tick(clock_timestamp()+interval '20 days')");assert.equal(sql('select count(*) from crm_automation_private.occurrences'),'2');
  assert.equal((await rpc('crm','snacky_crm_workspace_v1',{p_section:'task',p_id:task})).record.status,'completed');
 });
 sql('select crm_automation_private.tick()'); // Restore real heartbeat time after synthetic future dates.
 const arabic=await session('owner','ar',390);
 await check('real full-shell Arabic/English mobile and desktop layouts and accessibility',async()=>{
  const audits=[];
  for(const [label,p,url,width] of [['management-ar-390',arabic,'/my-work/team',390],['routines-ar-390',arabic,path,390],['editor-ar-320',arabic,path+'?edit='+id,320],['management-en-1440',owner,'/my-work/team',1440]]){
   await p.setViewportSize({width,height:950});await p.goto(app+url);await p.locator('main h1').waitFor();
   const overflow=await p.locator('main').evaluate(e=>Array.from(e.querySelectorAll('*')).filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&(r.right>innerWidth+2||r.left<-2);}).map(n=>n.tagName+':'+n.className));
   assert.deepEqual(overflow,[],label+' overflow');await p.screenshot({path:`${out}/${label}.png`,fullPage:true});
   const audit=await new AxeBuilder({page:p}).include('main').analyze();audits.push({label,violations:audit.violations});
  }
  writeFileSync(out+'/accessibility.json',JSON.stringify(audits,null,2));assert.equal(audits.flatMap(a=>a.violations).length,0,'New view accessibility violations');
 });
 await check('live route, stock and finance fixtures unchanged by recurring work',async()=>assert.equal(ledger(),baseline));
 assert.deepEqual(errors,[],'Browser errors');
}finally{
 await browser?.close();server?.kill('SIGTERM');if(server)await new Promise(r=>{server.once('exit',r);setTimeout(r,2000);});writeFileSync(out+'/results.json',JSON.stringify({results,errors},null,2));
}
