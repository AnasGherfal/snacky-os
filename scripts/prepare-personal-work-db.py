"""Build a disposable fixture using the existing authorization helper definitions.
No network, credentials, production access, or changes to migration source files.
"""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def between(path,start,end):
    value=(root/path).read_text()
    return value[value.index(start):value.index(end)]
base=(root/'scripts/owner-operations-db.sql').read_text().split('\\ir ')[0]
base+='''
alter table public.cash_collections add column counted_at timestamptz, add column storage_location text;
alter table snacky_private.cash_handovers add column storage_location text;
create table snacky_private.cash_handover_settings(singleton boolean primary key,enabled boolean);
create table snacky_private.cash_handover_counters(user_id uuid primary key,enabled boolean);
alter table buying_private.lists add column updated_at timestamptz default now(),add column created_by uuid;
alter table buying_private.items add column product_id uuid,add column bought_boxes integer default 0,add column units_per_box integer default 10;
create table buying_private.sources(list_id uuid,product_id uuid,primary_store jsonb);
create table public.purchase_order_lines(purchase_order_id uuid,product_id uuid,total_units integer);
alter table stocktake_private.assignments add column approved_at timestamptz,add column cancelled_at timestamptz;
create table stocktake_private.lines(assignment_id uuid,product_id uuid,counted_qty integer);
'''
base+=between('supabase/migrations/20260923120059_cash_handover_coordinator_v1.sql','create function snacky_private.cash_handover_counter_v1','-- A delegated count')
base+=between('supabase/migrations/20260920133731_shared_buying_lists.sql','create function buying_private.member()','create function buying_private.workspace')
base+=between('supabase/migrations/20260924112418_buying_purchase_link_v1.sql','create function buying_private.invoiced_units','create function buying_private.purchase_workspace')
base+='\n\\ir ../supabase/migrations/20260926134530_personal_work_today_v1.sql\n\\ir personal-work-db.sql\n'
(root/'scripts/.personal-work-db.sql').write_text(base)
