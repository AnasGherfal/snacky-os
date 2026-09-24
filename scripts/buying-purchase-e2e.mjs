// Disposable loopback Supabase only. Never accepts a production target.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';
const out='diagnostics/buying-purchase';mkdirSync(out,{recursive:true});
const cfg=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(x=>x.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(cfg.API_URL).hostname,'127.0.0.1');assert.equal(new URL(cfg.API_URL).port,'54321');
const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGPASSWORD:'postgres',PGDATABASE:'postgres'};
function sql(q){const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',q],{env:pg,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const accounts={},password='Only-local-'+randomUUID()+'-A9!';
for(const label of ['owner','buyer','other','operator']){
 const role=['buyer','other'].includes(label)?'warehouse':label,email='receipt-'+label+'@example.invalid';
 const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);
 const id=user.data.user.id,member=randomUUID();
 assert.ifError((await admin.from('team_members').insert({id:member,auth_user_id:id,full_name:'Receipt '+label,email,role,roles:[role],active:true,active_status:'active'})).error);
 assert.ifError((await admin.from('profiles').upsert({id,team_member_id:member,full_name:'Receipt '+label,email,role,roles:[role],active_status:'active',must_change_password:false})).error);
 const client=createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});assert.ifError((await client.auth.signInWithPassword({email,password})).error);accounts[label]={id,member,email,client};
}
const stores=Array.from({length:3},(_,n)=>({id:randomUUID(),name:['Primary store — المتجر الأول','Alternative store — المتجر البديل','Unapproved store'][n]}));
const products=Array.from({length:3},(_,n)=>({id:randomUUID(),sku:'QA-RECEIPT-'+n,name:'Receipt product '+(n+1)+' — منتج تجريبي',active:true,case_quantity:12,cost_price:1}));
const storage={id:randomUUID(),name:'Receipt QA storage — مخزن الاختبار',location_type:'main_storage',active:true};
assert.ifError((await admin.from('suppliers').insert(stores)).error);assert.ifError((await admin.from('products').insert(products)).error);assert.ifError((await admin.from('storage_locations').insert(storage)).error);
const today=sql("select (now() at time zone 'Africa/Tripoli')::date");
async function ordinary(product=products[0]){
 const r=await accounts.owner.client.rpc('snacky_create_purchase_with_lines_v2',{
 p_client_submission_id:randomUUID(),p_supplier_id:stores[0].id,p_order_date:today,p_receipt_number:null,p_payment_method:'cash',p_payment_status:'unpaid',p_receipt_url:null,p_receipt_file_name:null,p_receipt_content_type:null,p_receipt_storage_path:null,p_notes:'Isolated baseline',p_calculated_total_lyd:12,p_manual_total_lyd:null,p_total_adjustment_lyd:null,p_total_source:'calculated',p_total_amount:12,p_payment_account_id:'snacky_lyd',p_receiving_storage_location_id:storage.id,p_submit_action:'received',p_lines:[{product_id:product.id,line_position:0,boxes_qty:1,units_per_box:12,loose_units_qty:0,line_total:12}]});assert.ifError(r.error);return r.data;
}
await ordinary();
const regularWorkspace=async(id,role='owner')=>{const r=await accounts[role].client.rpc('snacky_buying_workspace_v1',{p_id:id});assert.ifError(r.error);return r.data;};
async function legacy(id,role,action,payload){const revision=action==='create'?0:(await regularWorkspace(id,role)).record.revision;const r=await accounts[role].client.rpc('snacky_buying_command_v1',{p_command:{request_id:randomUUID(),list_id:id,revision,action,payload}});assert.ifError(r.error);return r.data;}
async function seedList(title){
 const id=randomUUID();await legacy(id,'owner','create',{title,instructions:'Synthetic acceptance only',assigned_to:accounts.buyer.member,due_on:today,items:products.map((p,n)=>({product_id:p.id,boxes:n===0?3:2,units_per_box:12}))});
 for(const product of products){const r=await accounts.owner.client.rpc('snacky_buying_source_save_v1',{p_command:{request_id:randomUUID(),list_id:id,product_id:product.id,revision:(await regularWorkspace(id)).record.revision,primary_supplier_id:stores[0].id,alternative_supplier_id:stores[1].id,note:'Use approved stores only'}});assert.ifError(r.error);}
 await legacy(id,'buyer','item',{product_id:products[0].id,outcome:'partial',bought_boxes:2,note:'One box unavailable'});
 await legacy(id,'buyer','item',{product_id:products[1].id,outcome:'bought',bought_boxes:2,note:''});
 await legacy(id,'buyer','item',{product_id:products[2].id,outcome:'unavailable',bought_boxes:0,note:'Out of stock'});
 return id;
}
const list=await seedList('Same-person buying receipt test');
async function view(id=list,role='buyer'){const r=await accounts[role].client.rpc('snacky_buying_purchase_workspace_v1',{p_list:id});assert.ifError(r.error);return r.data;}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nN8AAAAASUVORK5CYII=','base64');
async function proof(id=list){
 const bytes=Buffer.concat([png,Buffer.from(randomUUID())]),sha=createHash('sha256').update(bytes).digest('hex'),path=`buying/${accounts.buyer.id}/${id}/${sha}.png`;
 assert.ifError((await admin.storage.from('receipt-images').upload(path,bytes,{contentType:'image/png',upsert:false})).error);
 return {receipt_path:path,receipt_sha256:sha,receipt_mime:'image/png',receipt_name:'test-receipt.png'};
}
async function createCommand({product=0,boxes=1,store=0,placed=false,cents=1200,id=list,...extra}={}){
 return {request_id:randomUUID(),list_id:id,revision:(await view(id)).revision,action:'create',payload:{supplier_id:stores[store].id,order_date:today,receipt_number:randomUUID(),lines:[{product_id:products[product].id,boxes,loose:0,line_total_cents:cents}],storage_id:placed?storage.id:null,placed_in_storage:placed,note:'',...await proof(id),...extra}};
}
const run=(command,role='buyer')=>accounts[role].client.rpc('snacky_buying_purchase_command_v1',{p_command:command});
const qty=product=>Number(sql(`select coalesce(sum(quantity_on_hand),0) from public.current_inventory_by_location where location_type='storage' and location_id='${storage.id}' and product_id='${product.id}'`));
const fingerprint=()=>sql("select jsonb_build_object('orders',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.purchase_orders x),'lines',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.purchase_order_lines x),'inventory',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.inventory_movements x),'products',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.products x),'links',(select count(*) from buying_private.purchase_links),'commands',(select count(*) from buying_private.purchase_requests))::text");
const finance=()=>sql("select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.financial_transactions x");
const financeBefore=finance(),routeCount=sql('select count(*) from public.routes');
const results=[];async function check(name,fn){try{await fn();results.push({name,status:'passed'});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:String(e.message)});throw e;}finally{writeFileSync(out+'/results.json',JSON.stringify(results,null,2));}}
let draft,draftCommand;
await check('only bought quantities are available; unavailable items never become stock',async()=>{const d=await view();assert.equal(d.items.length,2);assert.equal(d.items[0].remaining_units,24);assert.equal(d.items[0].primary.unit_cost_lyd,1);assert.equal(d.items.some(i=>i.product_id===products[2].id),false);});
await check('plain operator and unassigned warehouse employee cannot write receipts',async()=>{const c=await createCommand();for(const who of ['operator','other'])assert.equal((await run(c,who)).error?.code,'42501');});
await check('stale revision is rejected',async()=>{const c=await createCommand();c.revision--;assert.equal((await run(c)).error?.code,'40001');});
await check('unapproved stores, excessive quantities and missing image proof are rejected',async()=>{
 for(const params of [{store:2},{boxes:3,cents:3600}])assert.equal((await run(await createCommand(params))).error?.code,'23514');
 const c=await createCommand();c.payload.receipt_path=c.payload.receipt_path.replace(c.payload.receipt_sha256,'b'.repeat(64));assert.equal((await run(c)).error?.code,'23514');
});
await check('price increase needs an explanation rather than silently accepting historical prices',async()=>{assert.equal((await run(await createCommand({cents:1500}))).error?.code,'23514');});
await check('concurrent identical saves produce one draft and zero stock movements',async()=>{
 const before=qty(products[0]);draftCommand=await createCommand();const responses=await Promise.all([run(draftCommand),run(draftCommand)]);responses.forEach(r=>assert.ifError(r.error));assert.deepEqual(responses[0].data,responses[1].data);draft=responses[0].data.purchase_id;assert.equal(responses[0].data.status,'draft');assert.equal(qty(products[0]),before);assert.equal((await view()).receipts.length,1);assert.equal((await view()).items[0].remaining_units,12);
});
await check('changed request replay and the same physical receipt cannot create a second invoice',async()=>{
 assert.equal((await run({...draftCommand,payload:{...draftCommand.payload,note:'changed'}})).error?.code,'23505');
 assert.equal((await run({...draftCommand,request_id:randomUUID(),revision:(await view()).revision})).error?.code,'23505');
});
await check('checklist corrections cannot erase quantities already invoiced',async()=>{
 const c={request_id:randomUUID(),list_id:list,revision:(await view()).revision,action:'item',payload:{product_id:products[0].id,outcome:'unavailable',bought_boxes:0,note:'Invalid correction'}};
 const r=await accounts.buyer.client.rpc('snacky_buying_command_v1',{p_command:c});assert.equal(r.error?.code,'23514',JSON.stringify(r.error));assert.equal((await view()).items[0].remaining_units,12);
});
await check('linked receipt lines reject silent editing but remain receivable',async()=>{
 const r=await accounts.buyer.client.rpc('snacky_update_draft_purchase_v1',{p_purchase_id:draft,p_client_submission_id:randomUUID(),p_expected_updated_at:(await view()).receipts[0].version,p_supplier_id:stores[0].id,p_order_date:today,p_receiving_storage_location_id:null,p_receipt_number:draftCommand.payload.receipt_number,p_payment_method:'cash',p_receipt_url:'/api/storage/receipt-images/'+draftCommand.payload.receipt_path,p_receipt_file_name:'test-receipt.png',p_receipt_content_type:'image/png',p_receipt_storage_path:draftCommand.payload.receipt_path,p_notes:'Changing imported quantities',p_manual_total_lyd:24,p_lines:[{product_id:products[0].id,line_position:0,boxes_qty:2,units_per_box:12,loose_units_qty:0,total_units:24,ordered_qty:24,received_qty:0,line_total:24}]});
 assert.equal(r.error?.code,'23514',JSON.stringify(r.error));
});
await check('link/audit failure rolls back purchase, inventory, product costs and list revision',async()=>{
 const c=await createCommand({product:1,boxes:2,placed:true,cents:2400}),before=fingerprint(),rev=(await view()).revision;
 sql("create function buying_private.qa_fail_receipt() returns trigger language plpgsql as $$begin raise exception 'Injected test failure';end $$;create trigger qa_fail_receipt before insert on buying_private.purchase_requests for each row execute function buying_private.qa_fail_receipt();");
 try{assert.ok((await run(c)).error);assert.equal(fingerprint(),before);assert.equal((await view()).revision,rev);}finally{sql('drop trigger qa_fail_receipt on buying_private.purchase_requests;drop function buying_private.qa_fail_receipt();');}
 assert.ifError((await run(c)).error);assert.equal(qty(products[1]),24);
});
await check('same buyer receives their own draft exactly once without a witness',async()=>{
 const d=await view(),receipt=d.receipts.find(r=>r.purchase_id===draft),before=qty(products[0]);
 const c={request_id:randomUUID(),list_id:list,revision:d.revision,action:'receive',payload:{purchase_id:draft,version:receipt.version,storage_id:storage.id,confirmed:true}};
 const r=await run(c);assert.ifError(r.error);assert.deepEqual((await run(c)).data,r.data);assert.equal(qty(products[0]),before+12);
 const po=await admin.from('purchase_orders').select('created_by,received_by,status,payment_status').eq('id',draft).single();assert.ifError(po.error);assert.equal(po.data.created_by,accounts.buyer.member);assert.equal(po.data.received_by,accounts.buyer.member);assert.equal(po.data.status,'received');assert.equal(po.data.payment_status,'unpaid');
 assert.equal((await run({...c,request_id:randomUUID(),revision:(await view()).revision})).error?.code,'40001');
});
await check('approved alternative store can supply remaining units without duplicating the first receipt',async()=>{
 const c=await createCommand({store:1,placed:true,cents:1500,note:'Purchased the remaining box from approved alternative'});assert.ifError((await run(c)).error);assert.equal((await view()).items[0].remaining_units,0);assert.equal(qty(products[0]),36);
});
await check('Finance, routes and plain purchase entry retain existing behavior',async()=>{
 assert.equal(finance(),financeBefore);assert.equal(sql('select count(*) from public.routes'),routeCount);await ordinary(products[2]);assert.equal(qty(products[2]),12);assert.equal(finance(),financeBefore);
});
await check('cancelled draft retains history and permits one corrected copy of the same store receipt',async()=>{
 const id=await seedList('Receipt correction acceptance'),c=await createCommand({id}),before=qty(products[0]);
 const original=await run(c);assert.ifError(original.error);
 const cancelled=await accounts.buyer.client.rpc('snacky_cancel_draft_purchase_v1',{p_purchase_id:original.data.purchase_id,p_reason:'Correcting input before stock receipt',p_client_submission_id:randomUUID()});assert.ifError(cancelled.error);
 assert.equal((await view(id)).items[0].remaining_units,24);assert.equal(qty(products[0]),before);
 const corrected={...c,request_id:randomUUID(),revision:(await view(id)).revision,payload:{...c.payload,note:'Corrected entry with preserved original receipt history'}};
 const saved=await run(corrected);assert.ifError(saved.error);assert.notEqual(saved.data.purchase_id,original.data.purchase_id);
 const history=await view(id);assert.equal(history.receipts.length,2);assert.equal(history.receipts.filter(r=>r.status==='cancelled').length,1);assert.equal(history.items[0].remaining_units,12);assert.equal(qty(products[0]),before);
 assert.equal(sql(`select count(*) from buying_private.purchase_links where list_id='${id}' and retired_at is not null`),'1');
 assert.equal((await run({...corrected,request_id:randomUUID(),revision:history.revision})).error?.code,'23505');
});
await check('private receipt tables and public invoker boundaries stay restricted',async()=>{
 assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='buying_private' and c.relname in ('purchase_links','purchase_requests') and c.relrowsecurity"),'2');
 assert.equal(sql("select has_table_privilege('authenticated','buying_private.purchase_links','SELECT')"),'f');
 assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('snacky_buying_purchase_workspace_v1','snacky_buying_purchase_command_v1') and p.prosecdef"),'0');
});
await check('deactivated buyer cannot replay a previously successful receipt',async()=>{
 sql(`update public.profiles set active_status='inactive' where id='${accounts.buyer.id}'`);try{assert.equal((await run(draftCommand)).error?.code,'42501');}finally{sql(`update public.profiles set active_status='active' where id='${accounts.buyer.id}'`);}
});

// Test the real Next.js multipart endpoint and mobile controls, not a mocked screen.
const app='http://localhost:3000',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:cfg.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:cfg.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:cfg.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app};
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:35e6});writeFileSync(out+'/build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Production build must pass');
const require=createRequire(import.meta.url),{chromium}=require('../.qa/browser/node_modules/playwright');
const AxeBuilder=require('../.qa/browser/node_modules/@axe-core/playwright').default;
let browser,server;const uiList=await seedList('Phone receipt acceptance');
try{
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{env,stdio:['ignore',openSync(out+'/server.log','w'),openSync(out+'/server-errors.log','w')]});
 for(let n=0;n<90;n++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(n===89)throw Error('App failed to start');}
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(25000);
 await context.addCookies([{name:'snacky_os_language',value:'en',url:app}]);
 await page.goto(app+'/login');await page.locator('input[name=email]').fill(accounts.buyer.email);await page.locator('input[name=password]').fill(password);await Promise.all([page.waitForURL(u=>!u.pathname.startsWith('/login')),page.locator('form button[type=submit]').click()]);
 const path=app+'/buying-lists/'+uiList+'/purchases';await page.goto(path);
 await check('real phone receipt save survives a lost response and retries without duplicate stock',async()=>{
  await page.getByLabel('Actual store',{exact:true}).selectOption(stores[0].id);
  const row=page.locator('div.rounded-xl').filter({has:page.getByText(products[0].name,{exact:true})}).last();await row.getByRole('checkbox').check();await row.getByLabel('Boxes bought',{exact:true}).fill('1');await row.getByLabel('Total for this product (LYD)',{exact:true}).fill('12.00');
  await page.locator('input[type=file]').setInputFiles({name:'phone-receipt.png',mimeType:'image/png',buffer:png});
  // Retry is visible as soon as the request is persisted, before server commit.
  // Await the intercepted response before asserting or closing the browser.
  let settleIntercept;
  const intercepted=new Promise(resolve=>{settleIntercept=resolve;});
  const interceptTimeout=setTimeout(()=>settleIntercept({error:Error('Receipt interception did not finish')}),25000);
  const beforeSave=qty(products[0]);
  await page.route('**/api/buying-lists/purchases',async route=>{
   try{
    const response=await route.fetch({timeout:20000});
    const body=await response.json();
    if(body.ok)await route.abort('failed');else await route.fulfill({response});
    settleIntercept({body,status:response.status()});
   }catch(error){
    // Surface handler errors in the test, not as unhandled teardown rejections.
    try{await route.abort('failed');}catch{/* The request may already be closed. */}
    settleIntercept({error});
   }
  },{times:1});
  try{
   const [recorded]=await Promise.all([intercepted,page.getByRole('button',{name:'Save purchase — not yet stored',exact:true}).click()]);
   assert.ifError(recorded.error);assert.equal(recorded.status,200);assert.equal(recorded.body.ok,true);
   await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
   assert.equal((await view(uiList)).receipts.length,1);assert.equal(qty(products[0]),beforeSave);
   await page.reload();await page.getByRole('button',{name:'Retry same request',exact:true}).click();await page.getByText('Bought — not yet stored',{exact:true}).waitFor();
   assert.equal((await view(uiList)).receipts.length,1);assert.equal(qty(products[0]),beforeSave);
  }finally{
   clearTimeout(interceptTimeout);
   await page.unrouteAll({behavior:'wait'});
  }
 });
 await check('same person confirms storage through the actual mobile page',async()=>{
  await page.reload();const card=page.locator('article').first();await card.getByLabel('Where did you place the goods?',{exact:true}).selectOption(storage.id);
  await card.getByRole('checkbox').check();const before=qty(products[0]);await card.getByRole('button',{name:'Confirm placement in storage',exact:true}).click();await page.getByText('Placed in storage',{exact:true}).waitFor();assert.equal(qty(products[0]),before+12);
 });
 await check('Arabic 390px and 320px screens remain usable with no serious accessibility defects',async()=>{
  await context.addCookies([{name:'snacky_os_language',value:'ar',url:app}]);await page.reload();await page.getByText('نفس الشخص يشتري ويضع المنتجات في المخزن',{exact:true}).waitFor();
  for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));const scan=await new AxeBuilder({page}).include('main').analyze();writeFileSync(out+'/axe-'+width+'.json',JSON.stringify(scan.violations,null,2));assert.equal(scan.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);await page.screenshot({path:out+'/buyer-ar-'+width+'.png',fullPage:true});}
 });
 await check('cross-site submission and Finance page access remain denied',async()=>{
  const response=await page.request.post(app+'/api/buying-lists/purchases',{headers:{Origin:'https://untrusted.example'},data:{}});assert.equal(response.status(),403);await page.goto(app+'/finance');await page.waitForURL(/\/unauthorized/);assert.equal(sql('select count(*) from public.routes'),routeCount);assert.equal(finance(),financeBefore);
 });
 assert.deepEqual(errors,[]);
}finally{await browser?.close();server?.kill('SIGTERM');writeFileSync(out+'/results.json',JSON.stringify(results,null,2));}
console.log('PASS_COUNT '+results.length);
