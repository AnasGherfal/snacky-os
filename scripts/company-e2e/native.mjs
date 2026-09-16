// Existing assertions use real loopback services. Test-runner compatibility changes are explicit below.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,openSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');assert.equal(new URL(status.API_URL).port,'54321');assert.ok(status.SERVICE_ROLE_KEY&&status.ANON_KEY);
const app='http://localhost:3001',env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:'true',NEXT_PUBLIC_APP_URL:app,SNACKY_SMOKE_BASE_URL:app};
mkdirSync('diagnostics',{recursive:true});
if(!existsSync('.next/BUILD_ID')){const b=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});writeFileSync('diagnostics/native-build.log',b.stdout+'\n'+b.stderr);assert.equal(b.status,0,'Native build failed');}
// Production bundles need not serialize action names into public HTML. Use the actual
// reviewed build manifest to identify exports, then execute unchanged HTTP action payloads/assertions.
const original='scripts/test-vms-import-flow.mjs',temp='scripts/.qa-native-vms.mjs';
let text=readFileSync(original,'utf8');const marker='function extractActionId(html, actionName) {';
assert.equal(text.split(marker).length,2);
text=text.replace(marker,marker+`\n  const manifest=JSON.parse(readFileSync('.next/server/server-reference-manifest.json','utf8'));\n  const candidates=Object.entries({...manifest.node,...manifest.edge}).filter(([,entry])=>entry.exportedName===actionName&&entry.filename?.endsWith('src/lib/vms-import-actions.ts'));\n  if(candidates.length===1)return candidates[0][0];\n`);
writeFileSync(temp,text);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3001'],{env,stdio:['ignore',openSync('diagnostics/native-server.log','w'),openSync('diagnostics/native-server-errors.log','w')]});
const cases=['scripts/smoke-authenticated-pages.mjs','scripts/test-critical-workflows.mjs','scripts/test-route-inventory-regression.mjs','scripts/test-route-pickup-checklist-save.mjs',temp];const results=[];
try{
 for(let n=0;n<60;n++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(n===59)throw Error('App server not ready');}
 for(const file of cases){
  const name=file===temp?'test-vms-import-flow':file.split('/').pop().replace('.mjs',''),log=openSync(`diagnostics/${name}.log`,'w');
  const child=spawn(process.execPath,['--experimental-strip-types','--import','./scripts/company-e2e/native-fetch.mjs','--loader','./scripts/ts-alias-loader.mjs','--test',file],{env,stdio:['ignore',log,log]});
  const code=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');resolve(124);},180000);child.on('exit',c=>{clearTimeout(timer);resolve(c??1);});});
  results.push({file:file===temp?original:file,status:code===0?'passed':'failed',exit_code:code});console.log(`${code===0?'PASS':'FAIL'} ${file}`);
 }
 assert.ok(results.every(r=>r.status==='passed'),'Native integration failures: '+results.filter(r=>r.status!=='passed').map(r=>r.file).join(', '));
}finally{server.kill('SIGTERM');unlinkSync(temp);writeFileSync('diagnostics/native-results.json',JSON.stringify({runner_compatibility:['Explicit English locale','Actual build manifest export lookup for VMS actions; no mocked response or changed business assertion'],results},null,2));}
