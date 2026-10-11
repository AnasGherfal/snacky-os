import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as connection from '../src/lib/photo-ai-connection.ts';
import * as gallery from '../src/lib/xy-photo-gallery-test.ts';
const {resolvePhotoAiConnection,publicPhotoAiConnection,photoAiFailure}=connection;
const headers = token => new Headers(token ? {'x-vercel-oidc-token':token} : {});
const oidcEnv={VERCEL:'1'};
const token='unit-test-token-not-a-real-secret';

test('missing credentials fail closed, without fabricated AI results',()=>{
 assert.equal(resolvePhotoAiConnection({},headers()),null);
 assert.equal(resolvePhotoAiConnection({OPENAI_API_KEY:' ',AI_GATEWAY_API_KEY:'\t'},headers()),null);
});
test('existing direct OpenAI key keeps precedence and its billing route',()=>{
 const c=resolvePhotoAiConnection({...oidcEnv,OPENAI_API_KEY:' test-direct ',AI_GATEWAY_API_KEY:'test-gateway'},headers(token));
 assert.equal(c.provider,'openai');assert.equal(c.token,'test-direct');assert.equal(c.url,'https://api.openai.com/v1/responses');assert.equal(c.model,'gpt-4.1-mini');
});
test('existing Gateway key takes precedence over OIDC',()=>{
 const c=resolvePhotoAiConnection({...oidcEnv,AI_GATEWAY_API_KEY:'test-gateway'},headers(token));
 assert.equal(c.authMethod,'api_key');assert.equal(c.token,'test-gateway');assert.equal(c.model,'openai/gpt-4.1-mini');
});
test('Vercel uses the rotating request identity ahead of the environment fallback',()=>{
 const c=resolvePhotoAiConnection({...oidcEnv,VERCEL_OIDC_TOKEN:'old-test-token'},headers(token));
 assert.equal(c.provider,'vercel_gateway');assert.equal(c.authMethod,'vercel_oidc');assert.equal(c.token,token);
 assert.equal(c.url,'https://ai-gateway.vercel.sh/v1/responses');
 assert.equal(resolvePhotoAiConnection({...oidcEnv,VERCEL_OIDC_TOKEN:token},headers()).token,token);
});
test('untrusted client OIDC header is ignored outside Vercel',()=>{
 assert.equal(resolvePhotoAiConnection({},headers(token)),null);
 assert.equal(resolvePhotoAiConnection({VERCEL:'0',VERCEL_OIDC_TOKEN:token},headers(token)),null);
});
test('model namespace stays OpenAI and credentials never enter public diagnostics',()=>{
 const c=resolvePhotoAiConnection({...oidcEnv,XY_PHOTO_VISION_MODEL:'openai/gpt-4.1-mini'},headers(token));
 assert.equal(c.model,'openai/gpt-4.1-mini');
 assert.throws(()=>resolvePhotoAiConnection({...oidcEnv,XY_PHOTO_VISION_MODEL:'other/model'},headers(token)),/INVALID_MODEL/);
 const safe=publicPhotoAiConnection(c);assert.equal(safe.configured,true);assert.equal(safe.connectionVerified,false);
 assert.equal('token' in safe,false);assert.equal(JSON.stringify(safe).includes(token),false);
});
test('provider access, credit and rate-limit failures are explicit',()=>{
 assert.equal(photoAiFailure(402,'vercel_gateway').code,'PHOTO_AI_CREDITS_REQUIRED');
 assert.equal(photoAiFailure(403,'vercel_gateway').code,'PHOTO_AI_ACCESS_REQUIRED');
 assert.equal(photoAiFailure(429,'openai').code,'PHOTO_AI_LIMIT_REACHED');
});

// Execute the real endpoint with only its external imports replaced. No live
// database, credentials, image upload, billing calls or provider request is used.
const endpoint=fs.readFileSync(new URL('../src/app/api/admin/xy-photo-gallery-test/route.ts',import.meta.url),'utf8');
function harness({env=oidcEnv,role='owner',status=200,providerBody,productError=null}={}){
 const outbound=[];const reads=[];
 const q={select(){return q;},eq(){return q;},order(){return q;},limit:async()=>({data:[{id:'snack',name:'Snickers',active:true}],error:productError})};
 const imports={NextResponse:{json:(payload,init)=>new Response(JSON.stringify(payload),init)},getCurrentProfile:async()=>role?{id:'test-user',role,active_status:'active'}:null,hasRole:(p,r)=>p.role===r,getSupabaseAdminClient:()=>({from:table=>{reads.push(table);return q;}}),...connection,...gallery,process:{env},console:{warn(){}},fetch:async(url,options)=>{outbound.push({url,options});return new Response(JSON.stringify(providerBody??{output_text:JSON.stringify({photoQuality:'good',observations:[{rowNumber:1,positionNumber:1,productId:'snack',confidence:'high',visualEvidence:'Visible Snickers label'}]})}),{status});}};
 const source=stripTypeScriptTypes(endpoint).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport /g,'');
 const api=new Function(...Object.keys(imports),source+'\nreturn {GET,POST};')(...Object.values(imports));
 return {...api,outbound,reads};
}
function request({oidc=token,origin='https://snacky.example',type='image/jpeg',size=4}={}){
 const form=new FormData();form.set('photo',new File([new Uint8Array(size)],'test.jpg',{type}));
 return new Request('https://snacky.example/api/admin/xy-photo-gallery-test',{method:'POST',headers:{...Object.fromEntries(headers(oidc)),origin},body:form});
}
test('GET reports credential availability but never spends credits or reveals token',async()=>{
 const h=harness();const r=await h.GET(new Request('https://snacky.example',{headers:headers(token)}));
 const body=await r.json();assert.equal(body.configured,true);assert.equal(body.connectionVerified,false);assert.equal(body.provider,'vercel_gateway');assert.equal(h.outbound.length,0);assert.equal(h.reads.length,0);assert.equal(JSON.stringify(body).includes(token),false);
});
test('anonymous and nonowner users cannot use the billed AI endpoint',async()=>{
 for(const role of [null,'operator']){const h=harness({role});const r=await h.POST(request());assert.equal(r.status,role?403:401);assert.equal(h.outbound.length,0);}
});
test('cross-site photo requests are rejected before provider access',async()=>{
 const h=harness();assert.equal((await h.POST(request({origin:'https://attacker.invalid'}))).status,403);assert.equal(h.outbound.length,0);
});
test('successful OIDC photo request uses OpenAI through Gateway once, with no writes',async()=>{
 const h=harness();const r=await h.POST(request());const body=await r.json();assert.equal(r.status,200);assert.equal(body.ok,true);assert.equal(body.connectionVerified,true);assert.equal(body.observations[0].productName,'Snickers');assert.deepEqual(h.reads,['products']);assert.equal(h.outbound.length,1);
 const call=h.outbound[0];assert.equal(call.url,'https://ai-gateway.vercel.sh/v1/responses');assert.equal(call.options.headers.Authorization,`Bearer ${token}`);assert.equal(call.options.redirect,'error');const payload=JSON.parse(call.options.body);assert.equal(payload.store,false);assert.equal(payload.model,'openai/gpt-4.1-mini');assert.equal(payload.text.format.type,'json_schema');assert.equal(payload.input[0].content[1].type,'input_image');assert.equal(JSON.stringify(body).includes(token),false);
});
test('credit/access failures cause no retry, provider switch or fake detection',async()=>{
 for(const status of [401,402,403,429]){const h=harness({status,providerBody:{error:{message:'private provider detail'}}});const r=await h.POST(request());const body=await r.json();assert.equal(r.status,503);assert.equal(body.ok,false);assert.equal('observations' in body,false);assert.equal(h.outbound.length,1);assert.equal(JSON.stringify(body).includes('private provider detail'),false);}
});
test('unsupported photos, missing credentials and failed catalog reads do not call AI',async()=>{
 const bad=harness();assert.equal((await bad.POST(request({type:'text/plain'}))).status,400);assert.equal(bad.outbound.length,0);
 const missing=harness({env:{}});assert.equal((await missing.POST(request())).status,503);assert.equal(missing.outbound.length,0);
 const catalog=harness({productError:{message:'database failure'}});assert.equal((await catalog.POST(request())).status,503);assert.equal(catalog.outbound.length,0);
});
test('malformed provider output is not presented as a verified scan',async()=>{
 const h=harness({providerBody:{output_text:'{"observations":null}'}});const r=await h.POST(request());assert.equal(r.status,502);assert.equal((await r.json()).ok,false);
});
