"""Disposable CI fixture; original notification SQL/counter helper, no network."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
base='''
create schema buying_private;
create schema snacky_private;
create table buying_private.lists(id uuid primary key,title text,assigned_to uuid,created_by uuid,status text default 'open',revision integer default 1,due_on date,updated_at timestamptz default now());
create table public.cash_collections(id uuid primary key,cash_bag_id text,custody_status text default 'removed',actual_cash_collected numeric,voided_at timestamptz,storage_received_at timestamptz);
create table snacky_private.cash_handovers(collection_id uuid primary key references public.cash_collections(id),assigned_to uuid,stage text default 'assigned',deposited_at timestamptz,revision integer default 1);
create table snacky_private.cash_handover_counters(user_id uuid primary key,enabled boolean);
create function public.snacky_profile_has_any_role(profile_roles text[],primary_role text,allowed_roles text[])
returns boolean language sql stable as $$select (array[primary_role]||coalesce(profile_roles,'{}'))&&allowed_roles$$;
'''
# Use the actual existing counter authorization, not a permissive test stub.
cash=(root/'supabase/migrations/20260923120059_cash_handover_coordinator_v1.sql').read_text()
start=cash.index('create function snacky_private.cash_handover_counter_v1')
end=cash.index('-- A delegated count',start)
base+=cash[start:end]
base+='''
-- Sentinel source records must never be touched by this migration or its triggers.
create table public.test_notice_ledger_guard(id integer primary key,value numeric);
insert into public.test_notice_ledger_guard values(1,100);
create function public.deny_notice_ledger_write() returns trigger language plpgsql as $$begin raise exception 'Notification code changed ledger';end$$;
create trigger deny_notice_ledger_write before insert or update or delete on public.test_notice_ledger_guard for each row execute function public.deny_notice_ledger_write();
-- Capture the existing dispatcher source to prove the new branch preserves it.
create table public.test_existing_eligibility(body text);
insert into public.test_existing_eligibility select prosrc from pg_proc where oid='snacky_notice_private.eligible(public.notifications)'::regprocedure;
'''
(root/'scripts/.buying-cash-notice-fixture.sql').write_text(base)
