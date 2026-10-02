"""Disposable PostgreSQL only. No production credentials or network calls.
Installs the actual existing stocktake migration and its command/workspace bodies.
The minimal surrounding product/storage and role fixtures are not a full Supabase replay.
"""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
setup='''
alter table public.profiles add column full_name text;
alter table public.team_members add column full_name text;
create table public.storage_locations(id uuid primary key,name text,active boolean default true,location_type text default 'main_storage');
create table public.products(id uuid primary key,name text,sku text,category text,case_quantity integer default 1,active boolean default true);
create table public.inventory_movements(id uuid primary key,product_id uuid,quantity integer,from_entity_type text,from_entity_id uuid,to_entity_type text,to_entity_id uuid,created_at timestamptz default now());
create view public.current_inventory_by_location as select product_id,'storage'::text location_type,to_entity_id location_id,quantity quantity_on_hand from public.inventory_movements;
create function public.snacky_profile_has_any_role(profile_roles text[],primary_role text,allowed_roles text[])
returns boolean language sql stable as $$select (array[primary_role]||coalesce(profile_roles,'{}'))&&allowed_roles$$;
create function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(exists(select 1 from public.profiles p join public.team_members t on t.id=p.team_member_id
 where p.id=auth.uid() and p.active_status='active' and t.active_status='active' and t.active is true
 and (t.auth_user_id is null or t.auth_user_id=p.id)
 and ((array[p.role]||coalesce(p.roles,'{}')||array[t.role]||coalesce(t.roles,'{}'))&&allowed_roles)),false);
$$;
-- A non-zero approval writer is deliberately unavailable in this notification
-- test. Any accidental inventory adjustment aborts instead of being simulated.
create function public.snacky_create_storage_adjustment_v1(text,uuid,uuid,text,integer,text,text,timestamptz)
returns table(movement_id uuid) language plpgsql as $$begin raise exception 'Unexpected inventory adjustment in notification test';end$$;
'''
setup+='\n\\ir ../supabase/migrations/20260923154301_assigned_storage_stocktake_v1.sql\n'
setup+='''
create table public.test_stocktake_existing_eligibility(body text);
insert into public.test_stocktake_existing_eligibility select prosrc from pg_proc where oid='snacky_notice_private.eligible(public.notifications)'::regprocedure;
-- Sentinel rejects changes to the real fixture movement table after installation.
create function public.deny_stocktake_notice_inventory_write() returns trigger language plpgsql as $$begin raise exception 'Notification changed inventory';end$$;
create trigger deny_stocktake_notice_inventory_write before insert or update or delete on public.inventory_movements for each row execute function public.deny_stocktake_notice_inventory_write();
'''
(root/'scripts/.stocktake-notice-fixture.sql').write_text(setup)
