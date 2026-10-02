-- Customer relations may resolve small customer goodwill/refund cases directly.
-- Larger compensation requires a management role. This is an operational CRM
-- control only; refund_amount_lyd never creates a Finance ledger transaction.

create or replace function public.snacky_enforce_customer_compensation_limit_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $compensation$
declare
  compensation_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    compensation_changed := new.refund_amount_lyd is not null;
  elsif tg_op = 'UPDATE' then
    compensation_changed := new.refund_amount_lyd is distinct from old.refund_amount_lyd;
  end if;

  if compensation_changed
     and new.refund_amount_lyd is not null
     and new.refund_amount_lyd > 10
     and auth.uid() is not null
     and not public.snacky_crm_manager()
  then
    raise exception 'Customer Relations may approve up to 10 LYD per customer case. Above 10 LYD requires management approval.'
      using errcode = '42501';
  end if;
  return new;
end;
$compensation$;

drop trigger if exists issues_customer_compensation_limit_v1 on public.issues;
create trigger issues_customer_compensation_limit_v1
before insert or update of refund_amount_lyd on public.issues
for each row
execute function public.snacky_enforce_customer_compensation_limit_v1();

comment on function public.snacky_enforce_customer_compensation_limit_v1() is
'Enforces the Snacky customer-relations self-approval limit of 10 LYD per issue while allowing management to approve larger compensation.';

revoke all on function public.snacky_enforce_customer_compensation_limit_v1() from public, anon, authenticated;
