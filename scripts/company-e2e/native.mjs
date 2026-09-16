// Existing integration suites use only this disposable loopback stack.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,openSync,mkdirSync,existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const status=Object.fromEntries(readFileSync('.qa/local-status.env','utf8').split('\n').map(l=>l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map(m=>[m[1],m[2]]));
assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');assert.equal(new URL(status.API_URL).port,'54321');
assert.ok(status.SERVICE_ROLE_KEY&&status.ANON_KEY);
const app='http://localhost:3000';
const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:status.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:status.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:'true',NEXT_PUBLIC_APP_URL:app,SNACKY_SMOKE_BASE_URL:app};
mkdirSync('diagnostics',{recursive:true});
if(!existsSync('.next/BUILD_ID')){const b=spawnSync('npm',['run','build'],{env,encoding:'utf8',maxBuffer:30e6});writeFileSync('diagnostics/native-build.log',b.stdout+'\n'+b.stderr);assert.equal(b.status,0,'Native test app build failed');}
const server=spawn('npm',['run','start','--','--hostname','127.0.0.1'],{env,stdio:['ignore',openSync('diagnostics/native-server.log','w'),openSync('diagnostics/native-server-errors.log','w')]});
const cases=['scripts/smoke-authenticated-pages.mjs','scripts/test-critical-workflows.mjs','scripts/test-route-inventory-regression.mjs','scripts/test-route-pickup-checklist-save.mjs','scripts/test-vms-import-flow.mjs'];
const results=[];
try{
 for(let n=0;n<60;n++){try{if((await fetch(app+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,500));if(n===59)throw Error('App server not ready');}
 for(const file of cases){
  assert.ok(readFileSync(file,'utf8').includes('node:test'));
  const name=file.split('/').pop().replace('.mjs',''),log=openSync(`diagnostics/${name}.log`,'w');
  const child=spawn(process.execPath,['--experimental-strip-types','--loader','./scripts/ts-alias-loader.mjs','--test',file],{env,stdio:['ignore',log,log]});
  const code=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');resolve(124);},180000);child.on('exit',c=>{clearTimeout(timer);resolve(c??1);});});
  results.push({file,status:code===0?'passed':'failed',exit_code:code});console.log(`${code===0?'PASS':'FAIL'} ${file}`);
 }
 assert.ok(results.every(r=>r.status==='passed'),'Native integration failures: '+results.filter(r=>r.status!=='passed').map(r=>r.file).join(', '));
}finally{server.kill('SIGTERM');writeFileSync('diagnostics/native-results.json',JSON.stringify(results,null,2));}
