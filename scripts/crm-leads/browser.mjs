// Real local Auth/REST/database and the production app. Never uses production data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(import.meta.url);
const {chromium}=require('../../.qa/browser/node_modules/playwright');
const AxeBuilder=require('../../.qa/browser/node_modules/@axe-core/playwright').default;
const out='diagnostics/crm-leads';mkdirSync(out,{recursive:true});
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');assert.equal(new URL(status.API_URL).port,'54321');
assert.ok(status.ANON_KEY&&status.SERVICE_ROLE_KEY);
const app='http://localhost:3000',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app};
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:'postgres'};
function sql(q){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',q],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),accounts={};
const password=`Isolated-${randomUUID()}-A9!`;
for(const role of ['owner','crm','other','operator']){
  const actualRole=role==='other'?'crm':role,email=`lead-table-${role}@example.invalid`;
  const u=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(u.error);
  const id=u.data.user.id,member=randomUUID();
  assert.ifError((await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:`Fixture ${role}`,email,role:actualRole,roles:[actualRole],active:true,active_status:'active'})).error);
  assert.ifError((await admin.from('profiles').upsert({id,team_member_id:member,full_name:`Fixture ${role}`,email,role:actualRole,roles:[actualRole],active_status:'active',must_change_password:false})).error);
  const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  assert.ifError((await client.auth.signInWithPassword({email,password})).error);accounts[role]={email,id,member,client};
}
async function rpc(role,section='lead',filters={},id=null){
 const r=await accounts[role].client.rpc('snacky_crm_workspace_v1',{p_section:section,p_id:id,p_filters:filters});assert.ifError(r.error);return r.data;
}
const today=sql("select (now() at time zone 'Africa/Tripoli')::date"),yesterday=sql("select (now() at time zone 'Africa/Tripoli')::date-1");
const leads=Array.from({length:45},(_,n)=>({
 id:randomUUID(),place_name:n===44?'Zebra final-page target':'Training place '+String(n).padStart(2,'0')+' — مدرسة تدريبية',
 place_type:n%2?'school':'hospital',status:n===2?'negotiating':'interested',priority:n%5===0?'high':'normal',
 contact_person_name:'Office contact',contact_phone:'0911234567',contact_whatsapp:'0911234567',
 assigned_to_user_id:n<5?accounts.crm.member:accounts.owner.member,created_by_member_id:accounts.owner.member,
 area:n%2?'East':'West',visibility:'team',next_action:'Call the administrator and record the result',
 next_action_date:n===1?yesterday:today,is_practice:false,is_archived:false,
}));
const privateLead={...leads[0],id:randomUUID(),place_name:'Private other-employee fixture',visibility:'assigned',assigned_to_user_id:accounts.other.member,created_by_member_id:accounts.other.member};
const archived={...leads[0],id:randomUUID(),place_name:'Archived fixture',is_archived:true};
const practice={...leads[0],id:randomUUID(),place_name:'Practice fixture',is_practice:true};
assert.ifError((await admin.from('location_pipeline_leads').insert([...leads,privateLead,archived,practice])).error);
const ledger=()=>sql("select jsonb_build_object('routes',(select count(*) from public.routes),'inventory',(select count(*) from public.inventory_movements),'finance',(select count(*) from public.financial_transactions))::text");
const baseline=ledger(),results=[],pageErrors=[];let browser,server;
async function check(name,fn){
 try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}
 catch(e){results.push({name,status:'failed',message:String(e.message).slice(0,1600)});let i=0;for(const c of browser?.contexts()??[])for(const p of c.pages())try{await p.screenshot({path:`${out}/failure-${++i}.png`,fullPage:true});}catch{}throw e;}
 finally{writeFileSync(out+'/results.json',JSON.stringify({results,pageErrors},null,2));}
}
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});
writeFileSync('diagnostics/leads-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Production build failed');
try{
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{env,stdio:['ignore',openSync('diagnostics/leads-server.log','w'),openSync('diagnostics/leads-server-errors.log','w')]});
 for(let i=0;i<60;i++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(i===59)throw Error('Server unavailable');}
 browser=await chromium.launch({headless:true});
 async function session(role,locale='en',width=1440){
  const c=await browser.newContext({viewport:{width,height:1000}});
  await c.addCookies([{name:'snacky_os_language',value:locale,url:app}]);
  const p=await c.newPage();p.setDefaultTimeout(15000);p.setDefaultNavigationTimeout(30000);
  p.on('pageerror',e=>pageErrors.push(e.message));
  await p.goto(app+'/login');await p.locator('input[name=email]').fill(accounts[role].email);await p.locator('input[name=password]').fill(password);
  await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login')),p.locator('form button[type=submit]').click()]);
  return p;
 }
 const owner=await session('owner'),crm=await session('crm'),operator=await session('operator');
 const go=async(p,query='')=>{await p.goto(app+'/locations-pipeline'+query);await p.locator('#crm-leads').waitFor();};
 const table=p=>p.locator('#crm-leads table');
 await check('real desktop table, six aligned columns and original permission-checked data',async()=>{
  await go(owner);assert.equal(await table(owner).isVisible(),true);
  assert.equal(await table(owner).locator('thead th').count(),6);assert.equal(await table(owner).locator('tbody tr').count(),40);
  assert.equal((await rpc('owner')).total,46);assert.match(await owner.locator('#crm-leads').innerText(),/1–40 \/ 46/);
  assert.match(await table(owner).innerText(),/Contact|Owner/);assert.equal(await owner.locator('a[rel=next]').count(),1);
 });
 await check('CRM sees shared leads, cannot see other employees private leads, operator stays excluded',async()=>{
  await go(crm);assert.equal((await rpc('crm')).total,45);assert.doesNotMatch(await table(crm).innerText(),/Private other-employee fixture/);
  await go(crm,'?q=Private+other-employee+fixture');assert.match(await crm.locator('#crm-leads').innerText(),/No matching leads/);
  assert.ok((await accounts.crm.client.rpc('snacky_crm_workspace_v1',{p_section:'lead',p_id:privateLead.id})).error);
  await operator.goto(app+'/locations-pipeline');await operator.waitForURL(/\/unauthorized/);
 });
 await check('search applies to all pages and real form stage and employee filters',async()=>{
  await go(owner);await owner.getByRole('searchbox',{name:'Search',exact:true}).fill('Zebra');
  await owner.getByRole('button',{name:'Apply',exact:true}).click();await owner.waitForURL(u=>u.searchParams.get('q')==='Zebra');
  await table(owner).getByRole('link',{name:/Zebra final-page target/}).waitFor();assert.equal(await table(owner).locator('tbody tr').count(),1);
  await go(owner);await owner.getByRole('combobox',{name:'Stage',exact:true}).selectOption('negotiating');await owner.getByRole('button',{name:'Apply',exact:true}).click();
  await owner.waitForURL(u=>u.searchParams.get('status')==='negotiating');await table(owner).getByText('Negotiation',{exact:true}).waitFor();assert.equal(await table(owner).locator('tbody tr').count(),1);
  await go(owner);await owner.getByRole('combobox',{name:'Owner',exact:true}).selectOption(accounts.crm.member);
  await owner.getByRole('button',{name:'Apply',exact:true}).click();await owner.waitForURL(u=>u.searchParams.get('assigned_to')===accounts.crm.member);
  await table(owner).getByRole('link',{name:/Training place 00/}).waitFor();assert.equal(await table(owner).locator('tbody tr').count(),5);
 });
 await check('quick mine and overdue filters preserve their meaning',async()=>{
  await go(crm);await crm.getByRole('link',{name:'Assigned to me',exact:true}).click();await crm.waitForURL(u=>u.searchParams.get('scope')==='mine');
  await table(crm).getByRole('link',{name:/Training place 00/}).waitFor();assert.equal(await table(crm).locator('tbody tr').count(),5);
  await crm.getByRole('link',{name:'Overdue follow-ups',exact:true}).click();await crm.waitForURL(u=>u.searchParams.get('window')==='overdue');
  await table(crm).getByText('Overdue',{exact:true}).waitFor();assert.equal(await table(crm).locator('tbody tr').count(),1);
 });
 await check('pagination, contact links and archived/practice filters remain usable',async()=>{
  await go(owner);const first=await table(owner).locator('tbody th a').evaluateAll(a=>a.map(x=>x.href));
  await owner.locator('a[rel=next]').click();await owner.waitForURL(u=>u.searchParams.get('offset')==='40');
  await owner.locator('#crm-leads').getByText('41–46 / 46',{exact:true}).waitFor();
  const second=await table(owner).locator('tbody th a').evaluateAll(a=>a.map(x=>x.href));assert.equal(second.length,6);assert.equal(second.some(x=>first.includes(x)),false);
  assert.equal(await table(owner).locator('a[href="tel:+218911234567"]').count(),6);assert.equal(await table(owner).locator('a[href="https://wa.me/218911234567"]').count(),6);
  await go(owner,'?archived=true&practice=true');assert.equal((await rpc('owner','lead',{archived:'true',practice:'true'})).total,48);
  assert.equal(await owner.getByRole('checkbox',{name:'Include archived',exact:true}).isChecked(),true);assert.equal(await owner.getByRole('checkbox',{name:'Include practice',exact:true}).isChecked(),true);
 });
 await check('opening and assigning a lead uses the native edit form and persists after returning',async()=>{
  await go(owner,'?q=Zebra');await table(owner).getByRole('link',{name:/Zebra final-page target/}).click();await owner.waitForURL(u=>u.pathname.endsWith(leads[44].id));
  await owner.getByText('Edit record',{exact:true}).click();
  const responsible=owner.getByRole('combobox',{name:'Responsible employee',exact:true});
  await responsible.selectOption(accounts.crm.member);await owner.getByRole('textbox',{name:'Next action',exact:true}).fill('First assigned call — real test save');
  const form=responsible.locator('xpath=ancestor::form');
  const response=owner.waitForResponse(r=>r.url().endsWith('/api/crm/command')&&r.request().method()==='POST'&&r.request().postDataJSON()?.recordId===leads[44].id);
  await form.getByRole('button',{name:'Save changes',exact:true}).click();
  const saved=await response;assert.equal(saved.status(),200);const receipt=await saved.json();assert.equal(receipt.ok,true);assert.equal(receipt.id,leads[44].id);
  const actual=(await rpc('owner','lead',{},leads[44].id)).record;assert.equal(actual.assigned_to,accounts.crm.member);assert.equal(actual.next_action,'First assigned call — real test save');
  await go(crm,'?scope=mine&q=Zebra');await table(crm).getByText('First assigned call — real test save',{exact:true}).waitFor();
 });
 const arabic=await session('owner','ar',390),audits=[];
 await check('actual Arabic mobile and English desktop layouts, keyboard focus and scoped accessibility',async()=>{
  for(const [label,p,width] of [['leads-en-1440',owner,1440],['leads-en-1024',owner,1024],['leads-ar-390',arabic,390],['leads-ar-320',arabic,320]]){
   await p.setViewportSize({width,height:950});await go(p);
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Page overflow: '+label);
   if(width<768){assert.equal(await table(p).isVisible(),false);assert.equal(await p.locator('#crm-leads ol').isVisible(),true);assert.equal(await p.locator('#crm-leads').getAttribute('dir'),'rtl');}
   else{assert.equal(await table(p).isVisible(),true);await p.getByRole('region',{name:/Leads and visits table/}).focus();assert.equal(await p.getByRole('region',{name:/Leads and visits table/}).evaluate(el=>el===document.activeElement),true);}
   await p.screenshot({path:`${out}/${label}.png`,fullPage:true});
   const scan=await new AxeBuilder({page:p}).include('#crm-leads').analyze();audits.push({label,violations:scan.violations});
  }
  writeFileSync(out+'/accessibility.json',JSON.stringify(audits,null,2));assert.equal(audits.flatMap(a=>a.violations).length,0);
 });
 await check('existing routes, inventory and financial records untouched',async()=>assert.equal(ledger(),baseline));
 assert.deepEqual(pageErrors,[]);
}finally{
 await browser?.close();server?.kill('SIGTERM');
 if(server)await new Promise(r=>{server.once('exit',r);setTimeout(r,2000);});
 writeFileSync(out+'/results.json',JSON.stringify({results,pageErrors},null,2));
}
