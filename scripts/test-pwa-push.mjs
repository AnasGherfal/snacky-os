import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as crypto from 'node:crypto';
import ts from 'typescript';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function load(path, imports = {}, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(read(path), {compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(output, {exports, URL, atob, Buffer, Date, Promise, setTimeout, clearTimeout,
    console: {warn(){},error(){},info(){}}, ...globals, require(name) {
      assert.ok(name in imports, `Unexpected import ${name}`); return imports[name];
    }});
  return exports;
}
const validation = load('src/lib/push-subscription.ts');
const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
const keys = {p256dh:ec.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
const device = (name='one') => ({endpoint:'https://fcm.googleapis.com/fcm/send/'+name,keys});
for (const endpoint of ['http://127.0.0.1/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://evil.test/.push.apple.com','https://fcm.googleapis.com:8443/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com/x#frag','javascript:alert(1)']) {
  test('reject unsafe push endpoint '+endpoint, () => assert.equal(validation.isPushEndpoint(endpoint), false));
}
for (const host of ['fcm.googleapis.com','web.push.apple.com','updates.push.services.mozilla.com','wns2-par02p.notify.windows.com']) {
  test('accept push provider '+host, () => assert.equal(validation.isPushEndpoint('https://'+host+'/opaque'), true));
}
test('reject malformed subscription keys and non-object payloads', () => {
  for (const value of [null,[],1,'foo',{}, {...device(),keys:{p256dh:'bad',auth:keys.auth}}, {...device(),keys:{p256dh:keys.p256dh,auth:'bad'}}]) assert.equal(validation.parseDeviceSubscription(value), null);
  assert.equal(validation.parseDeviceSubscription(device()).endpoint, device().endpoint);
});

class Query {
  constructor(db,table){this.db=db;this.table=table;this.filters=[];this.options={};}
  select(_columns,options={}){this.options=options;return this;}
  eq(key,value){this.filters.push(row=>row[key]===value);return this;}
  is(key,value){return this.eq(key,value);}
  limit(value){this.maximum=value;return this;}
  maybeSingle(){this.single=true;return this;}
  order(){return this;}
  update(patch){this.patch=patch;return this;}
  insert(row){this.add=row;return this;}
  upsert(row){this.add=row;this.merge=true;return this;}
  then(resolve,reject){
    if(this.db.errors[this.table]) return Promise.resolve({error:{message:'unavailable',code:'42P01'},data:null,count:null}).then(resolve,reject);
    const all=this.db.rows[this.table]??=[];
    let rows=all.filter(row=>this.filters.every(filter=>filter(row)));
    if(this.patch) rows.forEach(row=>Object.assign(row,this.patch));
    if(this.add){ const existing=this.merge?all.find(row=>row.endpoint===this.add.endpoint):null;
      if(existing)Object.assign(existing,this.add);else all.push({id:crypto.randomUUID(),...this.add}); }
    const count=rows.length;
    if(this.maximum!==undefined)rows=rows.slice(0,this.maximum);
    return Promise.resolve({error:null,count,data:this.options.head?null:this.single?rows[0]??null:rows.map(row=>({...row}))}).then(resolve,reject);
  }
}
function database(){return {
  rows:{profiles:[{id:'user-a',active_status:'active',team_member_id:'team-a'}],
    push_subscriptions:[{...device(),...keys,id:'sub-a',user_id:'user-a',is_active:true},
      {...device('two'),...keys,id:'sub-a2',user_id:'user-a',is_active:true},
      {...device('other'),...keys,id:'sub-b',user_id:'user-b',is_active:true}],notifications:[]},
  errors:{}, reserved:true, from(table){return new Query(this,table);},
  async rpc(){return {data:this.reserved,error:null};}
};}
function sender(db,transport = async()=>{}) {
  return load('src/lib/notification-delivery.ts', {
    'server-only':{},'web-push':{__esModule:true,default:{setVapidDetails(){},sendNotification:transport}},
    'node:crypto':crypto,'@/lib/supabase-server':{getSupabaseAdminClient:()=>db},'@/lib/push-subscription':validation,
  },{process:{env:{SUPABASE_SERVICE_ROLE_KEY:'nonproduction-fixed-test-secret'}}});
}
function api(path,db,{profile={id:'user-a',active_status:'active'},send,config={configured:true,publicKey:keys.p256dh,source:'derived'}}={}) {
  const callbacks=[]; const waits=[];
  const delivery=sender(db,send);
  const module=load(path,{
    'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200,headers:options.headers})},after:callback=>callbacks.push(callback)},
    'node:timers/promises':{setTimeout:async ms=>{waits.push(ms);}},
    '@/lib/auth':{getCurrentProfile:async()=>profile,getAuthenticatedSupabaseServerClient:async()=>db},
    '@/lib/notification-delivery':{...delivery,ensurePushNotificationConfig:async()=>config},
    '@/lib/push-subscription':validation,
  });
  return {...module,callbacks,waits};
}
const request=(body,headers={})=>new Request('https://os.test/api/notifications/test',{
  method:'POST',headers:{'Content-Type':'application/json',Origin:'https://os.test',...headers},body:typeof body==='string'?body:JSON.stringify(body),
});
const statusPath='src/app/api/notifications/push-status/route.ts';
const testPath='src/app/api/notifications/test/route.ts';
const subPath='src/app/api/push-subscriptions/route.ts';
test('status checks BOTH tables and never converts missing schema into zero devices',async()=>{
  const db=database();db.errors.notifications=true;
  const result=await api(statusPath,db).GET();
  assert.equal(result.body.schemaReady,false);assert.equal(result.body.activeSubscriptions,null);assert.equal(result.body.deviceRegistered,false);
});
test('status verifies the current endpoint, keys, account and activation, not any registered device',async()=>{
  const db=database();const handler=api(statusPath,db);
  assert.equal((await handler.POST(request({subscription:device()}))).body.deviceRegistered,true);
  for(const sub of [device('missing'),device('other'),{...device(),keys:{...keys,auth:crypto.randomBytes(16).toString('base64url')}}]) {
    assert.equal((await handler.POST(request({subscription:sub}))).body.deviceRegistered,false);
  }
  db.rows.push_subscriptions[0].is_active=false;
  assert.equal((await handler.POST(request({subscription:device()}))).body.deviceRegistered,false);
});
test('status and mutation endpoints reject signed-out/inactive accounts',async()=>{
  for(const path of [statusPath,testPath,subPath]) for(const profile of [null,{id:'user-a',active_status:'inactive'}]) {
    assert.equal((await api(path,database(),{profile}).POST(request({subscription:device()}))).status,profile?403:401);
  }
});
test('cross-origin writes, malformed payloads and unsupported test delays fail closed',async()=>{
  for(const path of [statusPath,testPath,subPath]) {
    assert.equal((await api(path,database()).POST(request({}, {Origin:'https://evil.test'}))).status,403);
    for(const body of ['null','[]','{'])assert.equal((await api(path,database()).POST(request(body))).status,400);
  }
  assert.equal((await api(testPath,database()).POST(request({endpoint:device().endpoint,delaySeconds:999}))).status,400);
});
test('a test is sent to THIS device only, never another device/account',async()=>{
  const targets=[];const handler=api(testPath,database(),{send:async(sub)=>{targets.push(sub.endpoint);}});
  const result=await handler.POST(request({endpoint:device().endpoint}));
  assert.equal(result.status,200);assert.equal(result.body.acceptedCount,1);assert.deepEqual(targets,[device().endpoint]);
  assert.equal((await handler.POST(request({endpoint:device('other').endpoint}))).status,409);
});
test('rate limiting and schema failure never claim a test was sent',async()=>{
  const db=database();db.reserved=false;
  assert.equal((await api(testPath,db).POST(request({endpoint:device().endpoint}))).status,429);
  db.reserved=true;db.errors.push_subscriptions=true;
  assert.equal((await api(testPath,db).POST(request({endpoint:device().endpoint}))).status,503);
});
test('closed-app test responds first, then sends from the server after 15 seconds',async()=>{
  let sent=0;const handler=api(testPath,database(),{send:async()=>{sent++;}});
  const result=await handler.POST(request({endpoint:device().endpoint,delaySeconds:15}));
  assert.equal(result.status,202);assert.equal(result.body.scheduled,true);assert.equal(result.body.sent,false);assert.equal(sent,0);
  await handler.callbacks[0]();assert.deepEqual(handler.waits,[15000]);assert.equal(sent,1);
});
test('disabling/signing out or account deactivation before delayed test prevents sending',async()=>{
  for(const accountOff of [false,true]) {
    const db=database();let sent=0;const handler=api(testPath,db,{send:async()=>{sent++;}});
    await handler.POST(request({endpoint:device().endpoint,delaySeconds:15}));
    if(accountOff)db.rows.profiles[0].active_status='inactive';else db.rows.push_subscriptions[0].is_active=false;
    await handler.callbacks[0]();assert.equal(sent,0);
  }
});
test('transport failures remain failures; expired endpoints are deactivated',async()=>{
  const db=database();const deliver=sender(db,async()=>{throw {statusCode:410,message:'do-not-leak-endpoint'};});
  const result=await deliver.sendTestPushNotification(db,'user-a',{endpoint:device().endpoint});
  assert.equal(result.sent,false);assert.equal(result.acceptedCount,0);assert.equal(db.rows.push_subscriptions[0].is_active,false);
  assert.equal(db.rows.push_subscriptions[0].failure_reason,'push_service_http_410');
  assert.equal(db.rows.push_subscriptions[1].is_active,true);
});
test('sender validates endpoints again even when the database was written directly',async()=>{
  const db=database();db.rows.push_subscriptions[0].endpoint='http://127.0.0.1/secret';let calls=0;
  const result=await sender(db,async()=>{calls++;}).sendTestPushNotification(db,'user-a',{endpoint:'http://127.0.0.1/secret'});
  assert.equal(calls,0);assert.equal(result.sent,false);
});
test('disable endpoint affects only current user and specified device',async()=>{
  const db=database();const handler=api(subPath,db);
  assert.equal((await handler.DELETE(request({endpoint:device().endpoint}))).body.disabled,true);
  assert.equal(db.rows.push_subscriptions[0].is_active,false);assert.equal(db.rows.push_subscriptions[1].is_active,true);
  await handler.DELETE(request({endpoint:device('other').endpoint}));assert.equal(db.rows.push_subscriptions[2].is_active,true);
});
test('VAPID fallback is deterministic and does not return secret material',async()=>{
  const db=database();const one=await sender(db).ensurePushNotificationConfig(db);const two=await sender(db).ensurePushNotificationConfig(db);
  assert.equal(one.publicKey,two.publicKey);assert.equal(one.configured,true);assert.deepEqual(Object.keys(one).sort(),['configured','publicKey','source']);
});
function worker({clients=[],richFails=false}={}) {
  const listeners={},shown=[],opened=[],focused=[],navigated=[];
  const self={location:{origin:'https://os.test'},addEventListener:(name,callback)=>{listeners[name]=callback;},
    registration:{showNotification:async(title,options)=>{shown.push({title,options});if(richFails&&shown.length===1)throw Error('rich failed');}},
    clients:{matchAll:async()=>clients,openWindow:async url=>opened.push(url)}};
  vm.runInNewContext(read('public/sw.js'),{self,URL,encodeURIComponent,console:{error(){}}});
  async function push(payload){let work;listeners.push({data:{json:()=>payload},waitUntil:value=>{work=value;}});await work;}
  async function click(data){let work;listeners.notificationclick({notification:{data,close(){}},waitUntil:value=>{work=value;}});await work;}
  return {push,click,shown,opened,focused,navigated};
}
test('service worker invokes notification display without an open app window',async()=>{
  const sw=worker();await sw.push({title:'Test',body:'Body',url:'/account',lang:'ar',dir:'rtl'});
  assert.equal(sw.shown.length,1);assert.equal(sw.shown[0].options.dir,'rtl');assert.equal('renotify' in sw.shown[0].options,false);
  await sw.click(sw.shown[0].options.data);assert.equal(sw.opened[0],'https://os.test/account');
});
test('worker rejects malformed data and external click destinations',async()=>{
  for(const payload of [null,[],{url:'https://evil.test/x'},{url:'//evil.test/x'},{url:'javascript:alert(1)'},{url:'/login?next=https://evil.test'}]) {
    const sw=worker();await sw.push(payload);await sw.click(sw.shown[0].options.data);assert.equal(sw.opened[0],'https://os.test/account');
  }
});
test('worker preserves route deep links and rich-notification fallback',async()=>{
  const sw=worker({richFails:true});await sw.push({type:'route_assigned',routeId:'route-a',title:'Route'});
  assert.equal(sw.shown.length,2);assert.equal(sw.shown[0].options.tag,'route_assigned:route-a');
  assert.equal(sw.shown[0].options.renotify,true);await sw.click(sw.shown[1].options.data);assert.equal(sw.opened[0],'https://os.test/operator/routes/route-a');
});
test('worker navigates an existing window to the correct record before focus',async()=>{
  const events=[];const client={url:'https://os.test/dashboard',focus:async()=>events.push('focus'),navigate:async url=>{events.push(url);return client;}};
  const sw=worker({clients:[client]});await sw.click({url:'/operator/routes/one'});
  assert.deepEqual(events,['https://os.test/operator/routes/one','focus']);assert.equal(sw.opened.length,0);
});
test('iPhone/iPad install guidance and feature detection are accurate',()=>{
  for(const [userAgent,platform,touch,installed,expected] of [ ['iPhone','iPhone',5,false,true],['iPhone','iPhone',5,true,false],['Safari','MacIntel',5,false,true],['Android','Linux',5,false,false] ]) {
    const nav={userAgent,platform,maxTouchPoints:touch,serviceWorker:{}};
    const mod=load('src/lib/push-browser.ts',{}, {navigator:nav,window:{isSecureContext:true,Notification:{},PushManager:{},matchMedia:()=>({matches:installed})}});
    assert.equal(mod.needsHomeScreenInstall(),expected);assert.equal(mod.supportsPush(),true);
  }
});
test('service-worker activation is awaited and stalled readiness times out',async()=>{
  let resolveReady;const events=[];const ready=new Promise(resolve=>{resolveReady=resolve;});
  const mod=load('src/lib/push-browser.ts',{}, {navigator:{serviceWorker:{register:async()=>{events.push('registered');},ready}},window:{}});
  let complete=false;const pending=mod.getPushRegistration().then(()=>{complete=true;});
  await Promise.resolve();assert.equal(complete,false);resolveReady({active:true});await pending;assert.equal(complete,true);
  await assert.rejects(mod.withPushTimeout(new Promise(()=>{}),5),/timed out/);
});

test('in-flight push results cannot reactivate a device disabled concurrently', async () => {
  for (const fails of [false,true]) {
    const db=database();
    const deliver=sender(db,async()=>{db.rows.push_subscriptions[0].is_active=false;if(fails)throw {statusCode:503};});
    await deliver.sendTestPushNotification(db,'user-a',{endpoint:device().endpoint});
    assert.equal(db.rows.push_subscriptions[0].is_active,false);
  }
});

test('missing notification storage is a server setup error, not a phone delivery error', async () => {
  const db = database(); db.errors.notifications = true;
  let sent = 0;
  const result = await api(testPath, db, {send: async () => { sent++; }}).POST(request({endpoint:device().endpoint}));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'notification_storage_unavailable');
  assert.equal(result.body.sent, false); assert.equal(sent, 0);
  assert.doesNotMatch(result.body.error, /Re-enable/);
});

test('missing test migration reports server setup and never sends', async () => {
  const db=database(); db.rpc=async()=>({error:{code:'PGRST202'},data:null});
  let sent=0;
  const result=await api(testPath,db,{send:async()=>{sent++;}}).POST(request({endpoint:device().endpoint,locale:'ar'}));
  assert.equal(result.status,503);assert.equal(result.body.code,'push_test_setup_unavailable');
  assert.match(result.body.error,/الخادم/);assert.equal(sent,0);
});

for (const code of [401,403,404,410,429,503]) {
  test(`provider ${code} is reported safely with the right recovery action`,async()=>{
    const db=database();
    const result=await api(testPath,db,{send:async()=>{throw {statusCode:code,message:'private endpoint and credential details'};}}).POST(request({endpoint:device().endpoint,locale:'ar'}));
    const expired=[404,410].includes(code),server=[401,403].includes(code);
    assert.equal(result.status,expired?409:server?503:502);
    assert.equal(result.body.code,expired?'push_device_expired':server?'push_server_configuration':'push_delivery_failed');
    assert.equal(result.body.sent,false);
    assert.doesNotMatch(JSON.stringify(result.body),/credential|endpoint|fcm.googleapis|private/);
    assert.equal(db.rows.push_subscriptions[0].is_active,!expired);
    assert.equal(db.rows.push_subscriptions[1].is_active,true);
  });
}
