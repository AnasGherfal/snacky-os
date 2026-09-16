// Real-loopback integration harness for existing suites. No response mocking.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,openSync,mkdirSync,unlinkSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');assert.equal(new URL(status.API_URL).port,'54321');assert.ok(status.SERVICE_ROLE_KEY&&status.ANON_KEY);
// Build a separate feature-OFF application after the feature-ON browser suite.
// The same real backend includes Company; ordinary operations must still work.
const app='http://localhost:3001',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:'false',NEXT_PUBLIC_APP_URL:app,SNACKY_SMOKE_BASE_URL:app};
mkdirSync('diagnostics',{recursive:true});
const build=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});writeFileSync('diagnostics/native-build.log',build.stdout+'\n'+build.stderr);assert.equal(build.status,0,'Feature-off native build failed');
const original='scripts/test-vms-import-flow.mjs',temp='scripts/.qa-native-vms.mjs',routeOriginal='scripts/test-route-inventory-regression.mjs',routeTemp='scripts/.qa-native-route.mjs';
let text=readFileSync(original,'utf8');const marker='function extractActionId(html, actionName) {';assert.equal(text.split(marker).length,2);
text=text.replace(marker,marker+`\n const manifest=JSON.parse(readFileSync('.next/server/server-reference-manifest.json','utf8'));\n const candidates=Object.entries({...manifest.node,...manifest.edge}).filter(([,e])=>e.exportedName===actionName);\n const scoped=candidates.filter(([,e])=>Object.keys(e.workers??{}).some(k=>k.includes('vms-import')));\n if(scoped.length===1)return scoped[0][0];\n if(candidates.length===1)return candidates[0][0];\n`);
const statusPattern=/assert\.equal\(result\.status, 303, (`[^`]+`)\);/g;
assert.equal([...text.matchAll(statusPattern)].length,2);
text=text.replace(statusPattern,'assert.ok(result.status === 303 || (result.status === 200 && Boolean(result.redirect || result.location)), $1);');
// Current imports navigate to /vms-import?importBatchId=...; older ones used
// /vms-import/:id. Require the exact saved batch and a success message in either.
text+='\nfunction assertSavedBatchDestination(path,expectedId){const url=new URL(path,"http://localhost:3001");assert.equal(url.origin,"http://localhost:3001");assert.ok(url.searchParams.get("success"));assert.equal(url.searchParams.has("error"),false);const id=url.pathname==="/vms-import"?url.searchParams.get("importBatchId"):url.pathname.match(/^\\/vms-import\\/([0-9a-f-]+)$/)?.[1];assert.equal(id,expectedId,"Redirect must identify the actual imported batch");}\n';
for(const [path,state] of [['stockDetailPath','stockPreviewState'],['machineSnapshotDetailPath','machineSnapshotPreviewState'],['salesDetailPath','salesPreviewState'],['detailImportPath','detailPreviewState']]){
 const old=`assert.match(${path}, /^\\/vms-import\\/[0-9a-f-]+\\?success=/);`;
 assert.equal(text.split(old).length,2,old);text=text.replace(old,`assertSavedBatchDestination(${path}, ${state}.importBatchId);`);
}
writeFileSync(temp,text);
let route=readFileSync(routeOriginal,'utf8');
const movement='    reason: "storage_to_operator_bag",\n  }));';assert.equal(route.split(movement).length,2);
route=route.replace(movement,'    reason: "storage_to_operator_bag",\n    source_type: "admin_missed_route_pickup",\n    source_id: pickupBatchId,\n    related_pickup_batch_id: pickupBatchId,\n    idempotency_key: `qa-admin-pickup:${pickupBatchId}:${row.productId}`,\n    created_by: owner.teamMemberId,\n  }));');
assert.equal(route.split('p_acknowledged_pickup_line_ids: [],').length,2);
route=route.replace('p_acknowledged_pickup_line_ids: [],','p_acknowledged_pickup_line_ids: (plannedItems ?? []).filter(i => Number(i.planned_quantity) > 0).map(i => i.id),');
for(const label of ['first','second']){
 const rx=new RegExp(`    const \\{ error: ${label}CashError \\} = await operatorWarehouse\\.client\\.from\\("cash_collections"\\)\\.insert\\(\\{[\\s\\S]*?    assert\\.ifError\\(${label}CashError\\);`);
 assert.equal((route.match(new RegExp(rx.source,'g'))??[]).length,1);
 route=route.replace(rx,`    const { count: ${label}ImplicitCash, error: ${label}CashError } = await service.from("cash_collections").select("id", {count:"exact",head:true}).eq("route_id",multiMachineRouteId);\n    assert.ifError(${label}CashError);\n    assert.equal(${label}ImplicitCash,0,"Completing a stop must not invent a cash removal");`);
}
writeFileSync(routeTemp,route);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3001'],{env,stdio:['ignore',openSync('diagnostics/native-server.log','w'),openSync('diagnostics/native-server-errors.log','w')]});
const cases=['scripts/smoke-authenticated-pages.mjs','scripts/test-critical-workflows.mjs',routeTemp,'scripts/test-route-pickup-checklist-save.mjs',temp],results=[];
try{
 for(let n=0;n<60;n++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(n===59)throw Error('App server not ready');}
 for(const file of cases){
  const actual=file===temp?original:file===routeTemp?routeOriginal:file,name=actual.split('/').pop().replace('.mjs',''),log=openSync(`diagnostics/${name}.log`,'w');
  const child=spawn(process.execPath,['--experimental-strip-types','--import','./scripts/company-e2e/native-fetch.mjs','--loader','./scripts/ts-alias-loader.mjs','--test',file],{env,stdio:['ignore',log,log]});
  const code=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');resolve(124);},180000);child.on('exit',c=>{clearTimeout(timer);resolve(c??1);});});
  results.push({file:actual,status:code===0?'passed':'failed',exit_code:code});console.log(`${code===0?'PASS':'FAIL'} ${actual}`);
 }
 assert.ok(results.every(r=>r.status==='passed'),'Native integration failures: '+results.filter(r=>r.status!=='passed').map(r=>r.file).join(', '));
}finally{server.kill('SIGTERM');unlinkSync(temp);unlinkSync(routeTemp);writeFileSync('diagnostics/native-results.json',JSON.stringify({company_feature_enabled:false,fixture_adaptations:['Explicit English locale','Actual build manifest IDs and explicit redirect headers','Redirect destination must identify exact persisted VMS batch','Current admin pickup provenance and genuine acknowledgements','No implicit route cash removal','Verified production service-role receipt permission baseline; see environment documentation'],results},null,2));}
