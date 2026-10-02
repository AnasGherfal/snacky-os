import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const sql=readFileSync(new URL('../supabase/migrations/20260926153924_buying_cash_notifications_v1.sql',import.meta.url),'utf8');

test('default-off event integration, no backfill or extra scheduler',()=>{
 assert.match(sql,/enabled boolean not null default false/);
 assert.doesNotMatch(sql,/cron\.schedule|net\.http_post|fetch\(/i);
 assert.doesNotMatch(sql,/update\s+buying_private\.lists\s+set/i);
 assert.doesNotMatch(sql,/update\s+public\.cash_collections\s+set/i);
 assert.doesNotMatch(sql,/update\s+snacky_private\.cash_handovers\s+set/i);
});
test('only shopping assignment and physical pickup events',()=>{
 assert.match(sql,/after insert or update of assigned_to,status on buying_private\.lists/);
 assert.match(sql,/after insert or update of assigned_to,stage,deposited_at on snacky_private\.cash_handovers/);
 assert.match(sql,/after update of custody_status,storage_received_at,actual_cash_collected,voided_at,cash_bag_id/);
 assert.match(sql,/c\.custody_status='in_storage'/);
 assert.match(sql,/coalesce\(h\.deposited_at,c\.storage_received_at\) is not null/);
 assert.match(sql,/c\.actual_cash_collected is null/);
});
test('current canonical assignment and counter permission remain authoritative',()=>{
 assert.match(sql,/t\.auth_user_id is null or t\.auth_user_id=p\.id/);
 assert.match(sql,/cash_handover_counter_v1\(u\)/);
 assert.match(sql,/snacky_notice_private\.member_user\(n\.recipient_member_id\)=n\.user_id/);
 assert.match(sql,/g\.notification_id is distinct from n\.id/);
});
test('old generation cannot revive after reassignment and exact saves deduplicate',()=>{
 assert.match(sql,/generation=gen_random_uuid\(\),notification_id=null/);
 assert.match(sql,/is distinct from \(excluded\.assignment_key,excluded\.ready\)/);
 assert.match(sql,/if not found or not g\.ready/);
 assert.match(sql,/operational_generations\(source_kind,source_id,assignment_key,ready\)/);
});
test('notifications reuse existing per-device delivery and generic bilingual copy',()=>{
 assert.match(sql,/insert into public\.notifications/);
 assert.match(sql,/insert into snacky_notice_private\.deliveries/);
 assert.match(sql,/Shopping list assigned/);assert.match(sql,/تم إسناد قائمة شراء إليك/);
 assert.match(sql,/Cash box ready for pickup/);assert.match(sql,/صندوق نقد جاهز للاستلام/);
 assert.doesNotMatch(sql,/l\.title|cash_bag_id\s*\|\||storage_location\s*\|\||customer_phone|financial_transactions|inventory_movements|purchase_price/i);
});
test('only private functions; no direct browser grants',()=>{
 assert.doesNotMatch(sql,/create(?: or replace)? function public\./i);
 assert.match(sql,/operational_generations enable row level security/);
 assert.match(sql,/operational_settings enable row level security/);
 assert.match(sql,/from public,anon,authenticated/);
});
test('existing eligible function is extended without replacing earlier protections',()=>{
 assert.match(sql,/pg_get_functiondef\('snacky_notice_private\.eligible/);
 assert.match(sql,/patched:=replace\(d,anchor,anchor\|\|hook\)/);
 assert.match(sql,/Notification eligibility changed; review before installing/);
});
test('optional notification failures do not fail business operations or disable old worker',()=>{
 assert.match(sql,/Operational alert wake failed/);
 assert.match(sql,/set enabled=false,last_error_at=now\(\),last_error_code=sqlstate/);
 assert.doesNotMatch(sql,/update snacky_notice_private\.settings set enabled=false/);
 assert.match(sql,/Operational alerts paused after error/);
});
