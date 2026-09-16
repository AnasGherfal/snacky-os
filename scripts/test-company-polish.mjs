import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {companyWorkPaths,companyWorkLabel} from '../src/lib/company-hub.ts';
test('every supported working-screen choice has a human-readable Arabic and English label',()=>{
 for(const path of companyWorkPaths){assert.notEqual(companyWorkLabel(path,false),path);assert.notEqual(companyWorkLabel(path,true),path);assert.match(companyWorkLabel(path,true),/[\u0600-\u06ff]/);}
});
test('dashboard explicitly joins the operator FK in both supported read shapes',()=>{
 const s=readFileSync('src/app/dashboard/page.tsx','utf8');
 const start=s.indexOf('async function loadRouteRows('),end=s.indexOf('async function loadIssueRows(',start);assert.ok(start>=0&&end>start);
 const read=s.slice(start,end);
 assert.equal((read.match(/operator:team_members!routes_operator_id_fkey\(full_name\)/g)||[]).length,2);
 assert.doesNotMatch(read,/operator:team_members\(full_name\)/);
 assert.doesNotMatch(read,/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
 assert.match(read,/isMissingColumn\(withError\.error, \["last_completion_error"\]\)/);
});
