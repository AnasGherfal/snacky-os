// Real application + disposable loopback Auth/PostgreSQL. No production business writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(import.meta.url),{chromium,webkit}=require('../../.qa/browser/node_modules/playwright'),AxeBuilder=require('../../.qa/browser/node_modules/@axe-core/playwright').default;
const out='diagnostics/shared-buying';mkdirSync(out,{recursive:true});
const config=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(x=>x.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(config.API_URL).hostname,'127.0.0.1');assert.equal(new URL(config.API_URL).port,'54321');assert.ok(config.ANON_KEY&&config.SERVICE_ROLE_KEY);
const app='http://localhost:3000',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:config.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:config.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:config.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app};
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:'postgres'};
function sql(q){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',q],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),accounts={},password=`Isolated-${randomUUID()}-A9!`;
for(const role of ['owner','operator','other','crm']){
 const actualRole=role==='other'?'operator':role,email=`buying-${role}@example.invalid`,u=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(u.error);
 const id=u.data.user.id,member=randomUUID();assert.ifError((await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:`Buying ${role}`,email,role:actualRole,roles:[actualRole],active:true,active_status:'active'})).error);
 assert.ifError((await admin.from('profiles').upsert({id,team_member_id:member,full_name:`Buying ${role}`,email,role:actualRole,roles:[actualRole],active_status:'active',must_change_password:false})).error);
 const client=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});assert.ifError((await client.auth.signInWithPassword({email,password})).error);accounts[role]={id,member,email,client};
}
const products=Array.from({length:32},(_,i)=>({id:randomUUID(),sku:`QA-BUYING-${String(i+1).padStart(3,'0')}`,name:`Buying fixture ${String(i+1).padStart(2,'0')} — منتج تجريبي`,active:true,case_quantity:12,cost_price:2}));
assert.ifError((await admin.from('products').insert(products)).error);
const date=sql("select (now() at time zone 'Africa/Tripoli')::date"),ledger=()=>sql("select jsonb_build_object('routes',(select count(*) from public.routes),'inventory',(select count(*) from public.inventory_movements),'finance',(select count(*) from public.financial_transactions),'purchases',(select count(*) from public.purchase_orders),'purchase_lines',(select count(*) from public.purchase_order_lines),'purchase_payments',(select count(*) from public.purchase_payments))::text"),baseline=ledger();
async function record(role,id){const r=await accounts[role].client.rpc('snacky_buying_workspace_v1',{p_id:id,p_filters:{}});assert.ifError(r.error);return r.data;}
async function command(role,action,id,revision,payload={}){const r=await accounts[role].client.rpc('snacky_buying_command_v1',{p_command:{request_id:randomUUID(),list_id:id,revision,action,payload}});assert.ifError(r.error);return r.data;}
let browser,safari,server,listId;const results=[],pageErrors=[],audits=[];
async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',message:String(e.message).slice(0,2000)});let i=0;for(const b of [browser,safari])for(const c of b?.contexts()??[])for(const p of c.pages())try{await p.screenshot({path:`${out}/failed-${results.length}-${++i}.png`,fullPage:true});}catch{}console.error('FAIL '+name+': '+e.message);}finally{writeFileSync(out+'/results.json',JSON.stringify({results,pageErrors},null,2));}}
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:35e6});writeFileSync('diagnostics/buying-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Production build failed');
try{
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{env,stdio:['ignore',openSync('diagnostics/buying-server.log','w'),openSync('diagnostics/buying-server-errors.log','w')]});
 for(let i=0;i<60;i++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(i===59)throw Error('Server unavailable');}
 browser=await chromium.launch({headless:true});
 async function session(role,locale='en',width=1440,b=browser){const c=await b.newContext({viewport:{width,height:960},hasTouch:width<700});await c.addCookies([{name:'snacky_os_language',value:locale,url:app}]);const p=await c.newPage();p.setDefaultTimeout(20000);p.setDefaultNavigationTimeout(45000);p.on('pageerror',e=>pageErrors.push(e.message));await p.goto(app+'/login');await p.locator('input[name=email]').fill(accounts[role].email);await p.locator('input[name=password]').fill(password);await Promise.all([p.waitForURL(u=>!u.pathname.startsWith('/login')),p.locator('form button[type=submit]').click()]);return p;}
 const owner=await session('owner'),buyer=await session('operator'),other=await session('other'),crm=await session('crm');
 await check('owner shares the existing whole-box planning list; lost creation response recovers without duplicate',async()=>{
  await owner.evaluate(items=>localStorage.setItem('snacky-restock-shopping-list',JSON.stringify(items)),products.slice(0,3).map(p=>({productId:p.id,name:p.name,suggestedQty:24,purchaseUnit:'box',unitsPerBox:12,boxesQty:2,lastPurchaseCost:2})));
  await owner.goto(app+'/restock-priority/shopping-list');await owner.getByRole('textbox',{name:'List title',exact:true}).fill('Shared buyer acceptance');await owner.getByRole('combobox',{name:'Assigned buyer',exact:true}).selectOption(accounts.operator.member);await owner.getByRole('textbox',{name:'Buyer instructions',exact:true}).fill('Verify expiry and box size; report shortages.');
  let request,receipt;await owner.route('**/api/buying-lists',async route=>{if(route.request().method()!=='POST')return route.continue();request=route.request().postDataJSON();const response=await route.fetch();receipt=await response.json();if(receipt.ok)await route.abort('failed');else await route.fulfill({response});},{times:1});
  await owner.getByRole('button',{name:'Save & assign list',exact:true}).click();await owner.getByText('Save not confirmed. Retry the same saved request.',{exact:true}).waitFor();assert.equal(receipt.ok,true);listId=request.list_id;assert.equal(sql(`select count(*) from buying_private.lists where id='${listId}'`),'1');
  await owner.reload();const response=owner.waitForResponse(r=>r.url().endsWith('/api/buying-lists')&&r.request().method()==='POST');await owner.getByRole('button',{name:'Retry saved request',exact:true}).click();const saved=await response;assert.deepEqual(saved.request().postDataJSON(),request);assert.equal((await saved.json()).ok,true);await owner.waitForURL(u=>u.pathname==='/buying-lists/'+listId);
  const actual=(await record('owner',listId)).record;assert.equal(actual.items.length,3);assert.equal(actual.items[0].planned_boxes,2);assert.equal(actual.items[0].units_per_box,12);assert.equal(actual.assigned_to,accounts.operator.member);assert.equal(sql(`select count(*) from buying_private.commands where list_id='${listId}'`),'1');
 });
 await check('assigned operator opens the shared list on another account; other buyer and CRM cannot read it',async()=>{
  assert.ok(listId);await buyer.goto(app+'/buying-lists');await buyer.getByRole('link').filter({hasText:'Shared buyer acceptance'}).click();await buyer.waitForURL(u=>u.pathname.endsWith(listId));await buyer.getByRole('heading',{name:'Shared buyer acceptance',exact:true}).waitFor();
  for(const role of ['other','crm'])assert.ok((await accounts[role].client.rpc('snacky_buying_workspace_v1',{p_id:listId})).error);
  for(const p of [other,crm]){const result=await p.request.get(app+'/api/buying-lists?id='+listId);assert.equal(result.status(),403);}
  await other.goto(app+'/buying-lists');assert.equal(await other.getByText('Shared buyer acceptance',{exact:true}).count(),0);
  await buyer.goto(app+'/finance');await buyer.waitForURL(/\/unauthorized/);await buyer.goto(app+'/buying-lists/'+listId);
 });
 const itemForm=(p,n)=>p.locator('details').filter({has:p.locator('summary strong',{hasText:products[n].name})});
 const saveWait=p=>p.waitForResponse(r=>r.url().endsWith('/api/buying-lists')&&r.request().method()==='POST');
 await check('buyer saves bought quantity and planner sees the saved result after reloading',async()=>{
  const card=itemForm(buyer,0);await card.locator('summary').click();await card.getByRole('combobox',{name:'Item result',exact:true}).selectOption('bought');const response=saveWait(buyer);await card.getByRole('button',{name:'Save item result',exact:true}).click();assert.equal((await(await response).json()).ok,true);
  await owner.reload();assert.equal((await record('owner',listId)).record.items[0].bought_boxes,2);assert.equal((await record('owner',listId)).record.revision,2);await owner.locator('summary').filter({hasText:products[0].name}).getByText('Bought',{exact:false}).waitFor();
 });
 await check('partial and unavailable outcomes require reasons; completed checklist posts no stock or payment',async()=>{
  await buyer.reload();let card=itemForm(buyer,1);await card.locator('summary').click();await card.getByRole('combobox',{name:'Item result',exact:true}).selectOption('partial');await card.getByRole('spinbutton',{name:'Boxes actually bought',exact:true}).fill('1');await card.getByRole('textbox',{name:'Note or shortage reason',exact:true}).fill('Only one sealed box available');let response=saveWait(buyer);await card.getByRole('button',{name:'Save item result',exact:true}).click();assert.equal((await(await response).json()).ok,true);
  await buyer.reload();assert.equal(await buyer.getByRole('button',{name:'Finish buying list',exact:true}).isDisabled(),true);card=itemForm(buyer,2);await card.locator('summary').click();await card.getByRole('combobox',{name:'Item result',exact:true}).selectOption('unavailable');const reason=card.getByRole('textbox',{name:'Note or shortage reason',exact:true});assert.equal(await reason.getAttribute('required'),'');await reason.fill('Supplier has no stock');response=saveWait(buyer);await card.getByRole('button',{name:'Save item result',exact:true}).click();assert.equal((await(await response).json()).ok,true);
  await buyer.reload();buyer.once('dialog',d=>d.accept());response=saveWait(buyer);await buyer.getByRole('button',{name:'Finish buying list',exact:true}).click();assert.equal((await(await response).json()).ok,true);await buyer.getByRole('heading',{name:'Buying list checked',exact:true}).waitFor();assert.equal((await record('owner',listId)).record.status,'completed');assert.equal(ledger(),baseline);
 });
 await check('lost item response preserves exact request and can recover after reloading',async()=>{
  const current=(await record('owner',listId)).record;await command('owner','reopen',listId,current.revision);await buyer.reload();const card=itemForm(buyer,0);await card.locator('summary').click();await card.getByRole('textbox',{name:'Note or shortage reason',exact:true}).fill('Receipt to be recorded in the normal purchase workflow');let request,receipt;
  await buyer.route('**/api/buying-lists',async route=>{request=route.request().postDataJSON();const r=await route.fetch();receipt=await r.json();if(receipt.ok)await route.abort('failed');else await route.fulfill({response:r});},{times:1});await card.getByRole('button',{name:'Save item result',exact:true}).click();await buyer.getByText('Save not confirmed. Retry the same saved request.',{exact:true}).waitFor();assert.equal(receipt.ok,true);const revision=(await record('owner',listId)).record.revision;
  await buyer.reload();const response=saveWait(buyer);await buyer.getByRole('button',{name:'Retry saved request',exact:true}).click();const saved=await response;assert.deepEqual(saved.request().postDataJSON(),request);assert.equal((await saved.json()).ok,true);assert.equal((await record('owner',listId)).record.revision,revision);
 });
 const arabic=await session('operator','ar',390);
 await check('actual desktop and Arabic mobile checklist layout has no page overflow or scoped accessibility violations',async()=>{
  for(const [label,p,width] of [['buying-desktop',owner,1440],['buying-mobile-ar',arabic,390],['buying-mobile-small-ar',arabic,320]]){await p.setViewportSize({width,height:960});await p.goto(app+'/buying-lists/'+listId);await p.locator('#buying-list-detail').waitFor();assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),label);await p.screenshot({path:`${out}/${label}.png`,fullPage:true});const scan=await new AxeBuilder({page:p}).include('#buying-list-detail').analyze();audits.push({label,violations:scan.violations});}
  writeFileSync(out+'/accessibility.json',JSON.stringify(audits,null,2));assert.equal(audits.flatMap(a=>a.violations).length,0);
 });
 await check('multi-page A4 printable PDF retains first and last products and does not print navigation',async()=>{
  const largeId=randomUUID();await command('owner','create',largeId,0,{title:'Sample buying checklist — قائمة تجريبية',assigned_to:accounts.operator.member,due_on:date,instructions:'Synthetic example — not a real order. مثال للاختبار وليس طلب شراء.',items:products.map(p=>({product_id:p.id,boxes:2,units_per_box:12}))});
  await owner.goto(app+'/buying-lists/'+largeId+'/print');await owner.locator('[data-buying-print]').waitFor();await owner.pdf({path:out+'/Buying_List_Sample_EN.pdf',format:'A4',preferCSSPageSize:true,printBackground:true});
  const text=spawnSync('pdftotext',[out+'/Buying_List_Sample_EN.pdf','-'],{encoding:'utf8'});assert.equal(text.status,0);assert.match(text.stdout,/Buying fixture 01/);assert.match(text.stdout,/Buying fixture 32/);assert.match(text.stdout,/Not an invoice/);assert.doesNotMatch(text.stdout,/Print \/ Save PDF|Back to checklist|Device notifications/);
  await arabic.goto(app+'/buying-lists/'+largeId+'/print');await arabic.locator('[data-buying-print]').waitFor();await arabic.pdf({path:out+'/Buying_List_Sample_AR.pdf',format:'A4',preferCSSPageSize:true,printBackground:true});
  const arText=spawnSync('pdftotext',[out+'/Buying_List_Sample_AR.pdf','-'],{encoding:'utf8'});assert.equal(arText.status,0);assert.match(arText.stdout,/Buying fixture 32/);assert.ok(arText.stdout.includes('/buying-lists/'));
 });
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV5EAAAAASUVORK5CYII=','base64');
 async function fileTest(b,label){const p=await session('owner','en',390,b);await p.goto(app+'/purchases/new');const inputs=p.locator('[data-purchase-receipt-picker] input[type=file]');assert.equal(await inputs.count(),2);
  for(let n=0;n<2;n++){const input=inputs.nth(n);await input.scrollIntoViewIfNeeded();const event=p.waitForEvent('filechooser');await input.tap();const chooser=await event;assert.equal(chooser.isMultiple(),false);await chooser.setFiles({name:`receipt-${label}-${n}.png`,mimeType:'image/png',buffer:image});assert.equal(await input.evaluate(el=>el.files?.[0]?.name),`receipt-${label}-${n}.png`);assert.equal(await input.evaluate(el=>el.closest('label')===null),true);}
  await inputs.first().setInputFiles({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('not a receipt')});await p.locator('[data-purchase-receipt-picker]').first().getByRole('alert').waitFor();assert.equal(await inputs.first().evaluate(el=>el.files.length),0);await p.context().close();
 }
 await check('Chromium phone-sized native taps open both purchase receipt choosers without submitting a purchase',async()=>fileTest(browser,'chromium'));
 await check('WebKit touch input opens the manual and scan file choosers; unsupported files fail explicitly',async()=>{safari=await webkit.launch({headless:true});await fileTest(safari,'webkit');});
 await check('reassignment removes old buyer access while CRM can access only its newly assigned list',async()=>{
  const list=(await record('owner',listId)).record;await command('owner','assign',listId,list.revision,{assigned_to:accounts.crm.member});assert.ok((await accounts.operator.client.rpc('snacky_buying_workspace_v1',{p_id:listId})).error);await crm.goto(app+'/buying-lists/'+listId);await crm.getByRole('heading',{name:'Shared buyer acceptance',exact:true}).waitFor();assert.equal((await record('crm',listId)).planner,false);
  await crm.goto(app+'/purchases/new');await crm.waitForURL(/\/unauthorized/);assert.equal(ledger(),baseline);
 });
 assert.deepEqual(pageErrors,[]);assert.equal(results.filter(r=>r.status!=='passed').length,0,'Every scenario must pass');
}finally{await browser?.close();await safari?.close();server?.kill('SIGTERM');if(server)await new Promise(r=>{server.once('exit',r);setTimeout(r,1500);});writeFileSync(out+'/results.json',JSON.stringify({results,pageErrors},null,2));}
