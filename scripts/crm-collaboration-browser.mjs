import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium,expect}=require('../.qa/crm-browser/node_modules/@playwright/test');
const AxeBuilder=require('../.qa/crm-browser/node_modules/@axe-core/playwright').default;
const out='.qa/crm-evidence';fs.mkdirSync(out,{recursive:true});
const crm='22222222-2222-4222-8222-222222222222',owner='11111111-1111-4111-8111-111111111111',lead='60000000-0000-4000-8000-000000000041';
const browser=await chromium.launch({headless:true}),results=[];let page;
async function run(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(e){results.push({name,passed:false,error:e.message});if(page)await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});throw e;}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));}}
try{
 for(const ar of [false,true]){
  const context=await browser.newContext({viewport:{width:390,height:900}});page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  let role='crm',notes=[],labels=[],selected=[],revision=0,lose=false,failRead=false,clock=0;const receipts=new Map(),posted=[];
  const tr=(en,arabic)=>ar?arabic:en,me=()=>role==='owner'?owner:crm;
  function stamp(){return new Date(Date.now()+(++clock)).toISOString();}
  await page.route('**/api/crm/collaboration*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='GET'){
    if(failRead){await route.fulfill({status:503,json:{ok:false,code:'unavailable'}});return;}
    if(url.searchParams.get('kind')==='labels'){
     await route.fulfill({json:{ok:true,data:{kind:'labels',manager:role==='owner',me:me(),options:labels,selected:labels.filter(l=>selected.includes(l.id)),revision,lead_id:lead,can_edit:true,checked_at:stamp()}}});return;
    }
    const filter=url.searchParams.get('filter'),offset=Number(url.searchParams.get('offset')??0),rows=notes.filter(n=>role==='owner'||n.author_id===crm).filter(n=>filter==='all'||(filter==='done'?n.status==='done':n.status!=='done'));
    await route.fulfill({json:{ok:true,data:{kind:'notes',manager:role==='owner',me:me(),rows:rows.slice(offset,offset+10),total:rows.length,pending:notes.filter(n=>n.status!=='done').length,offset,page_size:10,checked_at:stamp()}}});return;
   }
   const c=request.postDataJSON();posted.push(c);let receipt=receipts.get(c.request_id);
   if(!receipt){
    if(c.action==='note.create'){notes.unshift({id:c.id,author_id:me(),author_name:role==='owner'?'Owner':'CRM employee',lead_id:c.payload.lead_id,lead_name:c.payload.lead_id?'Fixture lead':null,body:c.payload.body,status:'open',response:'',reviewer_name:null,revision:1,created_at:stamp(),updated_at:stamp()});}
    if(c.action==='note.review'){const n=notes.find(n=>n.id===c.id);n.status=c.payload.status;n.response=c.payload.response;n.reviewer_name='Owner';n.revision++;}
    if(c.action==='label.create')labels.push({id:c.id,owner_id:me(),owner_name:'CRM employee',name:c.payload.name,color:c.payload.color,revision:1});
    if(c.action==='label.update'){const l=labels.find(l=>l.id===c.id);l.name=c.payload.name;l.color=c.payload.color;l.revision++;if(c.payload.archived)labels=labels.filter(l=>l.id!==c.id);}
    if(c.action==='labels.set'){selected=c.payload.label_ids;revision++;}
    receipt={ok:true,request_id:c.request_id,id:c.id,action:c.action,revision:c.revision+1};receipts.set(c.request_id,receipt);
   }
   if(lose){lose=false;await route.abort('failed');return;}
   await route.fulfill({json:receipt});
  });
  const goto=()=>page.goto('http://127.0.0.1:3000/login/qa-crm-collaboration?lang='+(ar?'ar':'en')+'&role='+role);
  const savedNote=()=>page.locator('article p').filter({hasText:tr('Please approve the location visit','يرجى اعتماد زيارة الجهة')});
  const savedReply=()=>page.locator('article p').filter({hasText:tr('Please arrange it tomorrow','حددي الزيارة غداً')});
  // A restored textarea contributes text nodes to its wrapping label, and a
  // select contributes option text. Locate their stable accessible names,
  // without weakening exact matching or the saved-value assertions.
  const noteInput=()=>page.getByRole('textbox',{name:tr('New note','ملاحظة جديدة'),exact:true});
  const replyInput=()=>page.getByRole('textbox',{name:tr('Reply','الرد'),exact:true});
  const reviewStatus=()=>page.getByRole('combobox',{name:tr('Status','الحالة'),exact:true});
  await run((ar?'AR':'EN')+' note draft survives reload and lost response retries exact request',async()=>{
   await goto();await noteInput().fill(tr('Please approve the location visit','يرجى اعتماد زيارة الجهة'));
   await page.reload();await expect(noteInput()).toHaveValue(tr('Please approve the location visit','يرجى اعتماد زيارة الجهة'));
   lose=true;await page.getByRole('button',{name:tr('Send to management','إرسال للإدارة'),exact:true}).click();
   const retry=page.getByRole('button',{name:tr('Retry saved request','إعادة الطلب المحفوظ'),exact:true});await expect(retry).toBeEnabled();await retry.click();
   await expect(savedNote()).toBeVisible();assert.equal(notes.length,1);assert.deepEqual(posted[0],posted[1]);
  });
  await run((ar?'AR':'EN')+' unavailable read is not zero; retry recovers notes',async()=>{
   failRead=true;await page.getByRole('button',{name:tr('Refresh','تحديث'),exact:true}).click();await expect(page.locator('#crm-collab-fixture').getByRole('alert')).toBeVisible();
   assert.equal(await page.getByText(tr('No notes in this view.','لا توجد ملاحظات في هذا العرض.'),{exact:true}).count(),0);
   failRead=false;await page.getByRole('button',{name:tr('Retry','إعادة المحاولة'),exact:true}).click();await expect(savedNote()).toBeVisible();
  });
  await run((ar?'AR':'EN')+' personal label definition survives reload and applies to lead',async()=>{
   await page.getByRole('button',{name:tr('Labels','تصنيفات'),exact:true}).click();await page.getByLabel(tr('Label name','اسم التصنيف'),{exact:true}).fill(tr('This week','هذا الأسبوع'));
   await page.reload();await page.getByRole('button',{name:tr('Labels','تصنيفات'),exact:true}).click();await expect(page.getByLabel(tr('Label name','اسم التصنيف'),{exact:true})).toHaveValue(tr('This week','هذا الأسبوع'));
   await page.getByRole('button',{name:tr('Create label','إنشاء التصنيف'),exact:true}).click();await page.getByRole('checkbox',{name:tr('This week','هذا الأسبوع'),exact:true}).check();
   const saved=page.waitForResponse(r=>r.url().includes('/api/crm/collaboration')&&r.request().method()==='POST'&&r.request().postDataJSON().action==='labels.set');
   await page.getByRole('button',{name:tr('Save lead labels','حفظ تصنيفات الجهة'),exact:true}).click();await saved;await expect(page.getByRole('checkbox',{name:tr('This week','هذا الأسبوع'),exact:true})).toBeChecked();assert.equal(selected.length,1);
  });
  await run((ar?'AR':'EN')+' owner sees note, replies and marks reviewed; CRM sees response',async()=>{
   role='owner';await goto();await page.getByText(tr('Reply / update status','رد الإدارة / تحديث الحالة'),{exact:true}).click();await replyInput().fill(tr('Please arrange it tomorrow','حددي الزيارة غداً'));
   await reviewStatus().selectOption('seen');await page.getByRole('button',{name:tr('Save reply and status','حفظ الرد والحالة'),exact:true}).click();
   await expect(savedReply()).toBeVisible();role='crm';await goto();await expect(savedReply()).toBeVisible();
   assert.equal(await page.getByRole('button',{name:tr('Save reply and status','حفظ الرد والحالة'),exact:true}).count(),0);
  });
  await run((ar?'AR':'EN')+' mobile layout and accessibility at 390 and 320',async()=>{
   await page.getByRole('button',{name:tr('Labels','تصنيفات'),exact:true}).click();
   for(const width of [390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:out+'/'+(ar?'ar':'en')+'-'+width+'.png',fullPage:true});}
   const a=await new AxeBuilder({page}).include('#crm-collab-fixture').analyze();fs.writeFileSync(out+'/axe-'+(ar?'ar':'en')+'.json',JSON.stringify(a.violations));assert.equal(a.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);assert.deepEqual(errors,[]);
  });
  await context.close();
 }
}finally{await browser.close();}
console.log('All collaboration browser checks passed');
