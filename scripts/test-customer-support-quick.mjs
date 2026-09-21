import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const forms=fs.readFileSync('src/components/CrmRecordForms.tsx','utf8');
const workspace=fs.readFileSync('src/components/CrmWorkspace.tsx','utf8');
const migration=fs.readFileSync('supabase/migrations/20260921173500_customer_support_compensation_limit.sql','utf8');

test('new customer issue is a five-field quick intake before optional details',()=>{
  const start=forms.indexOf("if(!row){",forms.indexOf("if(kind==='issue')"));
  const end=forms.indexOf("}else{",start);
  const block=forms.slice(start,end);
  for(const field of ['customer_phone','location_id','issue_type','description','amount_involved_lyd']) assert.match(block,new RegExp("f\\('"+field+"'"));
  assert.match(block,/Contact channel[^]*value:'whatsapp'[^]*advanced:true/);
  assert.doesNotMatch(block,/f\('status'/);
  assert.doesNotMatch(block,/f\('next_action'/);
  assert.doesNotMatch(block,/assignee/);
});

test('My Work exposes the quick complaint action prominently',()=>{
  assert.match(workspace,/btn-primary" href="\/issues\/new"[^]*Quick customer issue[^]*بلاغ عميل سريع/);
  assert.match(workspace,/Record only the essentials now/);
});

test('CRM compensation is capped at 10 LYD for non-management users at UI and DB layers',()=>{
  assert.match(forms,/max:context\.manager\?undefined:10/);
  assert.match(forms,/Above 10 LYD requires management approval/);
  assert.match(migration,/new\.refund_amount_lyd > 10/);
  assert.match(migration,/not public\.snacky_crm_manager\(\)/);
  assert.match(migration,/before insert or update of refund_amount_lyd on public\.issues/);
});

test('quick intake defaults to WhatsApp but preserves other channels in optional details',()=>{
  assert.match(forms,/kind==='issue'\?\{contact_channel:'whatsapp'\}/);
  for(const channel of ['whatsapp','phone','email','other']) assert.match(forms,new RegExp("\\['"+channel+"'"));
});


test('Company Documents surfaces the approved Snacky profile inside the OS',()=>{
  const hub=fs.readFileSync('src/components/CompanyHub.tsx','utf8');
  const profile=fs.readFileSync('src/app/company/profile/page.tsx','utf8');
  assert.match(hub,/href="\\/company\\/profile"/);
  assert.match(hub,/Snacky Company Profile/);
  assert.match(profile,/خدمة أقرب\. ويوم أسهل\./);
  assert.match(profile,/requireCurrentProfileForPath\('\/company\/profile'\)/);
  assert.match(profile,/snacky\.ly/);
});
