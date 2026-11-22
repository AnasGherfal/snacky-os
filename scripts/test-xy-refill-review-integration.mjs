import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const read=p=>readFileSync(p,'utf8');
test('new XY review endpoint checks authorization before admin reads and never mutates business records',()=>{
 const s=read('src/app/api/routes/xy-review/route.ts');
 assert.ok(s.indexOf('canAccessPath')<s.indexOf('getSupabaseAdminClient();'));
 assert.match(s,/calculateXyRefillEvidence/);
 assert.match(s,/count:'exact'/);
 assert.doesNotMatch(s,/\.(insert|upsert|delete|update|rpc)\s*\(/);
});
test('wizard always requires re-review after changing an AI-generated quantity',()=>{
 const s=read('src/app/routes/new/RouteCreateForm.tsx');
 assert.match(s,/xyReviewedFingerprint !== xyReviewFingerprint/);
 assert.match(s,/onApprove=\{setXyReviewedFingerprint\}/);
 assert.match(s,/xyReviewPlannedItems/);
});
test('unproven physical product substitutions and forced remerchandising are disallowed',()=>{
 const s=read('src/lib/smart-route-planner.ts');
 assert.match(s,/if \(!explicitAllowed && !historicallySeen\) return null/);
 assert.match(s,/const stockoutReplaceNow = false/);
 assert.match(s,/const mixReplaceNow = false/);
});
