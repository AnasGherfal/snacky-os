import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import test from 'node:test';
const files=readdirSync('supabase/migrations').filter(x=>x.endsWith('_stocktake_notifications_v1.sql'));
assert.equal(files.length,1);
const sql=readFileSync('supabase/migrations/'+files[0],'utf8');
const read=p=>readFileSync(p,'utf8');
test('separate feature defaults off with no source backfill',()=>{
 assert.ok(sql.includes('enabled boolean not null default false'));
 assert.ok(sql.includes('No backfill'));
 assert.doesNotMatch(sql,/update\s+stocktake_private\.(assignments|lines)/i);
});
test('all three requested stocktake events have bilingual fixed copy',()=>{
 for(const text of ['Storage count assigned','Storage recount requested','Storage count ready for review','تم إسناد جرد مخزن إليك','مطلوب إعادة جرد المخزن','جرد المخزن جاهز للمراجعة'])assert.ok(sql.includes(text));
 assert.ok(sql.includes('Stock has not been adjusted.'));
});
test('copy never serializes count quantities titles notes or financial fields',()=>{
 for(const name of ['counted_qty','baseline_qty','variance_delta','financial_transactions','purchase_orders','storage_location','review_note','to_jsonb(new)'])assert.ok(!sql.includes(name),name);
});
test('identity resolves stocktake profile IDs to canonical active team links',()=>{
 assert.ok(sql.includes("target:=case when st='submitted' then c else a end"));
 assert.ok(sql.includes('t.auth_user_id is null or t.auth_user_id=p.id'));
 assert.ok(sql.includes("roles&&array['owner','admin']"));
 assert.ok(sql.includes("roles&&array['owner','admin','supervisor','warehouse']"));
});
test('same outbox and existing stocktake destination, no new sender or public API',()=>{
 assert.ok(sql.includes('snacky_notice_private.deliveries'));
 assert.ok(sql.includes('snacky_notice_private.wake()'));
 assert.ok(sql.includes("'/inventory/stocktake?id='"));
 assert.doesNotMatch(sql,/create\s+(or replace\s+)?function\s+public\./i);
 assert.doesNotMatch(sql,/cron\.schedule|net\.http_post|web-push/);
});
test('generation and live event identity rechecked before delivery',()=>{
 for(const check of ['g.notification_id is distinct from n.id','g.event_kind is distinct from n.event_kind',"s->>'state'=g.state",'g.assignee_user_id','g.reviewer_user_id','cfg.epoch=g0.epoch'])assert.ok(sql.includes(check));
});
test('source no-op saves cannot backfill pre-release notifications',()=>{
 assert.ok(sql.includes('(new.assigned_to,new.created_by,new.status)'));
 assert.ok(sql.includes('is not distinct from (old.assigned_to,old.created_by,old.status)'));
});
test('existing eligibility body is extended not replaced',()=>{
 assert.ok(sql.includes("anchor text:=E'\\nbegin\\n'"));
 assert.ok(sql.includes("replace(patched,hook,'') is distinct from d"));
 assert.ok(sql.includes('stocktake_notice_eligible(n)'));
});
test('fault isolates integration and rotates epoch without undoing business work',()=>{
 assert.ok(sql.includes('enabled=false,epoch=gen_random_uuid(),last_error_at=now(),last_error_code=code'));
 assert.ok(sql.includes('business action retained'));
 assert.doesNotMatch(sql,/set\s+enabled=false[^;]*snacky_notice_private\.settings/i);
});
test('private tables and new private functions are not browser APIs',()=>{
 assert.ok(sql.includes('stocktake_notice_settings enable row level security'));
 assert.ok(sql.includes('stocktake_notice_generations enable row level security'));
 assert.ok(sql.includes('from public,anon,authenticated'));
 assert.ok(sql.includes("set search_path=''"));
});
test('behavioral acceptance exercises actual existing stocktake commands',()=>{
 const t=read('scripts/push-tests/stocktake-notifications.sql');
 for(const text of ['snacky_storage_stocktake_command_v1','snacky_notification_delivery_payload_v1','recount','submitted','approved','cancelled','revoked owner/admin','no registered device','notification failure'])assert.ok(t.includes(text));
});
test('existing stocktake approval and command source are unchanged',()=>{
 const original=read('supabase/migrations/20260923154301_assigned_storage_stocktake_v1.sql');
 assert.ok(original.includes('snacky_create_storage_adjustment_v1'));
 assert.doesNotMatch(sql,/create\s+(or replace\s+)?function\s+stocktake_private\./i);
});
