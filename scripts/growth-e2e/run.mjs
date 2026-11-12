// Real local Auth/PostgREST/Next.js/Chromium. Never accepts a remote database.
// A finite staging acceptance run, not a production capacity certification.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { assertDisposableQaTarget, fetchLocalQaPage, assertRenderedQaPage } from '../qa-target-safety.mjs';
import { readCompleteList } from '../../src/lib/complete-list-read.ts';
const require = createRequire(import.meta.url);
const { chromium } = require('../../.qa/browser/node_modules/playwright');
const out = 'diagnostics/growth-full-stack'; mkdirSync(out, { recursive:true });
assert.match(readFileSync('.qa/full/supabase/config.toml','utf8'), /project_id = "snacky-company-isolated"/);
const local = Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n')
  .map(line=>line.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const app = 'http://localhost:3001';
assertDisposableQaTarget({appUrl:app,databaseUrl:local.API_URL,deploymentEnvironment:process.env.VERCEL_ENV});
assert.ok(local.ANON_KEY && local.SERVICE_ROLE_KEY);
const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:local.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:local.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY,NEXT_PUBLIC_APP_URL:app,
  NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:'false',SNACKY_SMOKE_BASE_URL:app};
const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,opts);
const password=`Local-growth-${randomUUID()}-Aa9!`,prefix=randomUUID().slice(0,8);
const results=[],accounts=[],metrics=[];
let server,browser;
function save(){writeFileSync(`${out}/results.json`,JSON.stringify({commit:process.env.GITHUB_SHA,
  target:'disposable-loopback-only',synthetic_data:true,users:20,machines:50,
  limits:'Finite authenticated staging checks, not a production throughput or long-duration certification.',results,metrics},null,2));}
async function check(name,fn){const start=Date.now();try{await fn();results.push({name,status:'passed',duration_ms:Date.now()-start});console.log('PASS '+name);}
  catch(error){results.push({name,status:'failed',message:String(error.message).slice(0,1800),duration_ms:Date.now()-start});console.error('FAIL '+name);}
  finally{save();}}
async function insert(table,records){const r=await admin.from(table).insert(records);assert.ifError(r.error);}
async function person(role,index){
  const email=`growth-${prefix}-${role}-${index}@example.invalid`;
  const user=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(user.error);
  const id=user.data.user.id,member=randomUUID();
  const account={id,member,email,role};accounts.push(account);
  await insert('team_members',{id:member,auth_user_id:id,full_name:`Growth QA ${role} ${index}`,email,role,roles:[role],active:true,active_status:'active'});
  const p=await admin.from('profiles').upsert({id,team_member_id:member,full_name:`Growth QA ${role} ${index}`,email,role,roles:[role],active_status:'active',must_change_password:false});assert.ifError(p.error);
  const client=createClient(local.API_URL,local.ANON_KEY,opts);account.client=client;
  const login=await client.auth.signInWithPassword({email,password});assert.ifError(login.error);
  const session=login.data.session;assert.ok(session);
  account.cookie=`snacky-auth-access-token=${session.access_token}; snacky-auth-refresh-token=${session.refresh_token}; snacky_os_language=en`;
  return account;
}
function ledgerCounts(){
  const pg={...process.env,PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:'postgres'};
  const r=spawnSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-c',`select jsonb_build_object('inventory',(select count(*) from public.inventory_movements),'cash',(select count(*) from public.cash_collections),'finance',(select count(*) from public.financial_transactions))::text;`],{env:pg,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,'Local ledger probe failed');return JSON.parse(r.stdout.trim());
}
async function html(path,who){const start=performance.now(),response=await fetchLocalQaPage(app,path,who.cookie);
  const body=await response.text();metrics.push({path:path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g,':id'),status:response.status,ms:Math.round(performance.now()-start)});
  assertRenderedQaPage({status:response.status,finalUrl:response.url,contentType:response.headers.get('content-type'),body},app,path);return body;}
async function json(path,who){const start=performance.now(),response=await fetchLocalQaPage(app,path,who.cookie,'manual');
  const body=await response.json();metrics.push({path:'/api/operator/routes/:id/pick-list',status:response.status,ms:Math.round(performance.now()-start)});
  assert.equal(response.status,200,`Pick list failed (${response.status})`);assert.ok(!body.error,body.error);return body;}
const operators=[];let owner,routeIds=[],machines=[],products=[],largeRoute;
try{
  await check('create 20 distinct authenticated operators, 50 machines and realistic route-line fixtures locally',async()=>{
    owner=await person('owner',0);
    for(let i=0;i<20;i++)operators.push(await person('operator',i));
    const locationId=randomUUID();await insert('locations',{id:locationId,name:`Growth QA ${prefix}`,location_type:'office',status:'active'});
    machines=Array.from({length:50},(_,i)=>({id:randomUUID(),machine_code:`GQA-${prefix}-${i}`,name:`Growth machine ${i+1}`,location_id:locationId,status:'active'}));
    products=Array.from({length:30},(_,i)=>({id:randomUUID(),sku:`GQA-${prefix}-P${i}`,name:`Growth product ${i+1}`,category:'snack',cost_price:1,selling_price:2,current_cost_price_lyd:1,current_selling_price_lyd:2,active:true,case_quantity:18}));
    await insert('machines',machines);await insert('products',products);
    const today=new Date().toISOString().slice(0,10);
    const routes=operators.map(op=>({id:randomUUID(),route_date:today,operator_id:op.member,status:'assigned',created_by:owner.member,notes:'Synthetic read-only growth fixture'}));
    routeIds=routes.map(r=>r.id);await insert('routes',routes);
    const stops=machines.map((m,i)=>({id:randomUUID(),route_id:routes[i%20].id,machine_id:m.id,stop_order:Math.floor(i/20)+1,status:'pending'}));await insert('route_stops',stops);
    const lines=stops.flatMap(stop=>products.map(product=>({id:randomUUID(),route_id:stop.route_id,route_stop_id:stop.id,machine_id:stop.machine_id,product_id:product.id,planned_quantity:1,source:'manual_admin_assignment'})));
    for(let i=0;i<lines.length;i+=250)await insert('route_stop_items',lines.slice(i,i+250));
    largeRoute={id:randomUUID(),route_date:today,operator_id:operators[0].member,status:'draft',created_by:owner.member,notes:'Unassigned 50-machine draft for overflow-read acceptance'};
    await insert('routes',largeRoute);
    const largeStops=machines.map((m,i)=>({id:randomUUID(),route_id:largeRoute.id,machine_id:m.id,stop_order:i+1,status:'pending'}));await insert('route_stops',largeStops);
    const largeLines=largeStops.flatMap(stop=>products.map(product=>({id:randomUUID(),route_id:stop.route_id,route_stop_id:stop.id,machine_id:stop.machine_id,product_id:product.id,planned_quantity:1,source:'manual_admin_assignment'})));
    for(let i=0;i<largeLines.length;i+=250)await insert('route_stop_items',largeLines.slice(i,i+250));
    assert.equal(lines.length,1500);assert.equal(largeLines.length,1500);
  });
  assert.equal(results[0].status,'passed','Local fixture setup failed');
  await check('owner exact-count read retrieves 1,500 draft lines through the real API cap',async()=>{
    const r=await readCompleteList(({from,to,signal})=>owner.client.from('route_stop_items')
      .select('id,route_id,product_id,planned_quantity',{count:'exact'}).eq('route_id',largeRoute.id).order('id').range(from,to).abortSignal(signal),{key:r=>r.id});
    assert.equal(r.error,null);assert.equal(r.count,1500);assert.equal(r.data.reduce((n,r)=>n+r.planned_quantity,0),1500);
  });
  const baseline=ledgerCounts();
  const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:40e6,timeout:540000});
  writeFileSync(`${out}/build.log`,`${build.stdout??''}\n${build.stderr??''}`);assert.equal(build.status,0,'Local production build failed');
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3001'],{env,stdio:['ignore',openSync(`${out}/server.log`,'w'),openSync(`${out}/server-errors.log`,'w')]});
  for(let n=0;n<90;n++){try{if((await fetch(app+'/login',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(n===89)throw Error('Local app not ready');await new Promise(r=>setTimeout(r,500));}
  await check('20 simultaneous signed-in operators load only their own actual assigned routes',async()=>{
    await Promise.all(operators.map(async(op,i)=>{
      const body=await html('/operator/routes',op);
      assert.ok(body.includes(routeIds[i]),'Own route missing');
      for(let j=0;j<routeIds.length;j++)if(j!==i)assert.ok(!body.includes(routeIds[j]),'Another operator route leaked');
    }));
  });
  await check('20 concurrent authenticated pickup API reads return all assigned lines',async()=>{
    await Promise.all(operators.map(async(op,i)=>{
      const data=await json(`/api/operator/routes/${routeIds[i]}/pick-list`,op);
      assert.equal(data.routeItemCount,(i<10?3:2)*30);
      assert.equal(data.pendingStopCount,i<10?3:2);
    }));
  });
  await check('large operator pickup API includes all 1,500 planned lines and 50 stops',async()=>{
    const data=await json(`/api/operator/routes/${largeRoute.id}/pick-list`,operators[0]);
    assert.equal(data.routeItemCount,1500);assert.equal(data.pendingStopCount,50);
  });
  await check('cross-operator route identifiers are denied under 20 simultaneous requests',async()=>{
    await Promise.all(operators.map(async(op,i)=>{
      const r=await fetchLocalQaPage(app,`/api/operator/routes/${routeIds[(i+1)%20]}/pick-list`,op.cookie,'manual');
      assert.ok([403,404].includes(r.status),`Foreign route must be denied, got ${r.status}`);await r.body?.cancel();
    }));
  });
  await check('large owner route and operational stock pages render without false zero or truncation errors',async()=>{
    for(const path of [`/routes/${largeRoute.id}`,'/routes','/inventory','/inventory?view=operator-bags','/restock-priority','/cash-collections']){
      const body=await html(path,owner);
      assert.doesNotMatch(body,/Route quantities could not be verified|Route movement history is incomplete|Complete ledger balances could not be verified/);
    }
  });
  await check('reading route, stock, restock and cash pages does not mutate inventory or money',async()=>{
    assert.deepEqual(ledgerCounts(),baseline);
  });
  await check('strict existing owner, warehouse, operator and viewer smoke suite',async()=>{
    const log=openSync(`${out}/strict-smoke.log`,'w');
    const child=spawn(process.execPath,['--experimental-strip-types','--import','./scripts/company-e2e/native-fetch.mjs','--test','scripts/smoke-authenticated-pages.mjs'],{env,stdio:['ignore',log,log]});
    const code=await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGTERM');resolve(124);},180000);child.on('exit',c=>{clearTimeout(t);resolve(c??1);});});
    assert.equal(code,0,'Strict page acceptance failed; see strict-smoke.log');
  });
  await check('real Arabic and English mobile route navigation renders without horizontal overflow',async()=>{
    browser=await chromium.launch({headless:true});
    for(const language of ['en','ar']){
      const context=await browser.newContext({viewport:{width:390,height:844}});
      const session=(await owner.client.auth.getSession()).data.session;
      await context.addCookies([{name:'snacky-auth-access-token',value:session.access_token,url:app},
        {name:'snacky-auth-refresh-token',value:session.refresh_token,url:app},{name:'snacky_os_language',value:language,url:app}]);
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      const response=await page.goto(app+'/routes');assert.equal(response.status(),200);await page.locator('main').waitFor();
      assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'Horizontal overflow on mobile');
      assert.deepEqual(errors,[]);await page.screenshot({path:`${out}/routes-${language}-390.png`,fullPage:true});await context.close();
    }
  });
}finally{
  await browser?.close();server?.kill('SIGTERM');
  for(const account of accounts){try{await account.client?.auth.signOut({scope:'global'});}catch{}}
  save();
}
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
