import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
import * as company from '../src/lib/company-hub.ts';
const read=p=>fs.readFileSync(p,'utf8'),manifest=JSON.parse(read('src/lib/company-proposal-kit.json'));
const jsx=(type,props)=>({type,props});
function load(path,imports,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,console,File,FormData,Response,Request,URL,AbortSignal,TextEncoder,crypto:webcrypto,atob,Uint8Array,require(k){assert.ok(k in imports,k);return imports[k];},...extra});return exports;}
const domain=load('src/lib/company-proposal-import.ts',{'./company-proposal-kit.json':{default:manifest},'./company-hub':company});
const user='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
function* nodes(n){if(Array.isArray(n)){for(const x of n)yield*nodes(x);}else if(n&&typeof n==='object'){yield n;yield*nodes(n.props?.children);}}
test('manifest contains all eight actual PDFs and six editable masters, never empty placeholder files',()=>{assert.equal(manifest.length,14);assert.equal(manifest.filter(x=>x.name.endsWith('.pdf')).length,8);assert.equal(manifest.filter(x=>x.name.endsWith('.pptx')).length,6);const ids=new Set();for(const entry of manifest){assert.ok(entry.size>0&&entry.size<=company.companyFileLimit);assert.match(entry.digest,/^[0-9a-f]{64}$/);for(const part of ['file','item']){const id=domain.kitUuid(entry.digest,part);assert.match(id,company.companyUuid);assert.ok(!ids.has(id));ids.add(id);}}assert.ok(!manifest.some(x=>x.name==='Snacky_Company_Profile_AR.pdf'));});
test('internal kit publication never grants external approval; older PDFs remain management-only',()=>{for(const entry of manifest){const d=company.validateCompanyContent(domain.kitContent(entry,owner,'2026-12-20'));assert.equal(d.external_shareable,false);assert.equal(d.notify,false);assert.equal(d.requires_ack,false);assert.equal(d.file_id,domain.kitUuid(entry.digest,'file'));assert.equal(d.audience.includes('crm'),!entry.management_only);assert.match(d.body_en,/original approved September profile record is not replaced/);}});
test('unknown, corrupted, repeated and oversized bundles fail before uploading',async()=>{await assert.rejects(()=>domain.readKitFiles([]));await assert.rejects(()=>domain.readKitFiles([new File(['%PDF-FAKE'],manifest[0].name)]));await assert.rejects(()=>domain.readKitFiles([new File(['{}'],'bad.json')]));await assert.rejects(()=>domain.readKitFiles([new File(['x'.repeat(domain.kitBundleLimit+1)],'big.json')]));});
test('edited or archived drafts are never silently republished',()=>{const entry=manifest[0],data=domain.kitContent(entry,owner,'2026-12-20'),r={id:domain.kitUuid(entry.digest,'item'),current_version:0,archived:false,data};assert.equal(domain.untouchedKitDraft(r,entry),true);assert.equal(domain.untouchedKitDraft({...r,archived:true},entry),false);assert.equal(domain.untouchedKitDraft({...r,data:{...data,title_en:'Edited'}},entry),false);assert.equal(domain.untouchedKitDraft({...r,data:{...data,external_shareable:true}},entry),false);});
async function clientHarness({loseSave=false,corruptDownload=false}={}){
 const bytes=new TextEncoder().encode('%PDF-1.7\nSynthetic import test bytes only.');
 const digest=await domain.bytesDigest(bytes.buffer),entry={...manifest[0],name:'synthetic.pdf',size:bytes.length,digest};
 const lib=load('src/lib/company-proposal-import.ts',{'./company-proposal-kit.json':{default:[entry]},'./company-hub':company});
 const records=[],registered=[],stored=new Map(),requests=[],receipts=new Map(),hooks=[];let cursor=0,failOnce=loseSave;
 const fetch=async(url,options={})=>{
  const json=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
  if(url==='/api/company/proposal-kit')return json({ok:true,data:{user_id:user,directory:[{id:owner,name:'Owner'}],records,files:registered}});
  if(url==='/api/company/files'&&options.method==='POST'){
   const id=options.body.get('id'),file=options.body.get('file');stored.set(id,await file.arrayBuffer());registered.push({id,digest});requests.push({action:'upload',id});return json({ok:true,id});
  }
  if(url.startsWith('/api/company/files/'))return new Response(corruptDownload?'corrupted':stored.get(url.split('/').at(-1)));
  if(url==='/api/company/command'){
   const c=JSON.parse(options.body);requests.push(c);let receipt=receipts.get(c.request_id);
   if(!receipt){let record=records.find(x=>x.id===c.item_id);if(c.action==='save'){assert.equal(record,undefined);record={id:c.item_id,revision:1,current_version:0,archived:false,data:c.payload};records.push(record);}else{assert.equal(c.action,'publish');assert.equal(record.revision,c.revision);record.revision++;record.current_version++;}receipt={ok:true,id:c.item_id,request_id:c.request_id,revision:record.revision,version:record.current_version};receipts.set(c.request_id,receipt);}
   if(c.action==='save'&&failOnce){failOnce=false;throw Error('Simulated lost response');}return json(receipt);
  }
  throw Error('Unexpected request '+url);
 };
 function slot(init){const i=cursor++;if(!(i in hooks))hooks[i]=typeof init==='function'?init():init;return [hooks[i],v=>hooks[i]=typeof v==='function'?v(hooks[i]):v];}
 const component=load('src/components/CompanyProposalImport.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:'a'},react:{useState:slot,useRef:v=>slot({current:v})[0]},'@/lib/company-proposal-import':lib,'@/lib/company-hub':company},{fetch});
 const render=()=>{cursor=0;return component.CompanyProposalImport({ar:false,userId:user,defaultOwner:owner,reviewDate:'2026-12-20'});};
 const file=new File([bytes],'synthetic.pdf',{type:'application/pdf'});
 const choose=async()=>{const input=[...nodes(render())].find(x=>x.props?.type==='file');await input.props.onChange({target:{files:[file]}});};
 const run=async()=>{const button=[...nodes(render())].find(x=>x.type==='button');assert.equal(button.props.disabled,false);await button.props.onClick();};
 return {choose,run,records,requests,render,entry,lib};
}
test('real client handler uploads bytes, checks the stored download, saves and publishes via native endpoints',async()=>{const h=await clientHarness();await h.choose();assert.equal(h.requests.length,0);await h.run();assert.deepEqual(h.requests.map(x=>x.action),['upload','save','publish']);assert.equal(h.records[0].current_version,1);assert.equal(h.records[0].data.external_shareable,false);assert.equal(h.records[0].data.audience.includes('crm'),true);await h.run();assert.equal(h.requests.length,3,'repeat import must not duplicate or republish');});
test('lost create response recovers the same content-addressed item, never a duplicate',async()=>{const h=await clientHarness({loseSave:true});await h.choose();await h.run();assert.equal(h.records.length,1);assert.equal(h.records[0].current_version,0);await h.run();assert.equal(h.records.length,1);assert.equal(h.records[0].current_version,1);assert.equal(h.requests.filter(x=>x.action==='upload').length,1);assert.equal(h.requests.filter(x=>x.action==='save').length,1);});
test('corrupt storage response blocks document creation/publication',async()=>{const h=await clientHarness({corruptDownload:true});await h.choose();await h.run();assert.equal(h.records.length,0);assert.deepEqual(h.requests.map(x=>x.action),['upload']);});
test('concurrent button clicks have one synchronous execution lock',async()=>{const h=await clientHarness();await h.choose();const button=[...nodes(h.render())].find(x=>x.type==='button');await Promise.all([button.props.onClick(),button.props.onClick()]);assert.equal(h.records.length,1);assert.equal(h.requests.filter(x=>x.action==='upload').length,1);});
test('status route denies non-management before querying and does not use admin credentials or writes',async()=>{let calls=0;const routes=load('src/app/api/company/proposal-kit/route.ts',{'@/lib/company-server':{companySession:async()=>({manager:false,db:{rpc(){calls++;}}}),companyJson:(body,status=200)=>({body,status})},'@/lib/company-proposal-import':domain});assert.equal((await routes.GET()).status,403);assert.equal(calls,0);const text=read('src/app/api/company/proposal-kit/route.ts');assert.doesNotMatch(text,/service.role|SUPABASE_SERVICE|\.insert\(|\.update\(|snacky_company_command_v1/);assert.match(read('src/app/company/import/page.tsx'),/if \(!session\?\.manager\) redirect/);});
test('unavailable status is an explicit error, never fabricated zero registered files',async()=>{const routes=load('src/app/api/company/proposal-kit/route.ts',{'@/lib/company-server':{companySession:async()=>({manager:true,db:{rpc:async()=>({error:{code:'timeout'}})}}),companyJson:(body,status=200)=>({body,status})},'@/lib/company-proposal-import':domain});const r=await routes.GET();assert.equal(r.status,503);assert.equal(r.body.ok,false);});
