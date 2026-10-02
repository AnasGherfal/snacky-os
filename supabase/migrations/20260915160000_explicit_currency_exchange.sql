-- One native Snacky transfer represents both account impacts. Do not insert
-- two transfer rows: each transfer row already projects a debit and a credit.
alter table public.financial_transactions add column if not exists transfer_destination_amount numeric(12,2);
comment on column public.financial_transactions.transfer_destination_amount is 'Exact amount received in the destination currency for an explicit currency exchange. Never infer equal LYD and USD amounts.';

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.financial_transactions'::regclass and conname='finance_exchange_destination_positive') then
    alter table public.financial_transactions add constraint finance_exchange_destination_positive check (transfer_destination_amount is null or (transfer_destination_amount > 0 and transfer_destination_amount < 10000000000));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.financial_transactions'::regclass and conname='finance_new_cross_currency_has_destination') then
    alter table public.financial_transactions add constraint finance_new_cross_currency_has_destination check (
      transaction_effect is distinct from 'transfer' or transaction_date <= date '2026-05-15'
      or right(source_account_id,3)=right(destination_account_id,3)
      or (transfer_destination_amount is not null and transfer_destination_amount > 0)
    ) not valid;
  end if;
end $$;

create or replace function public.snacky_record_currency_exchange_v1(
  p_client_submission_id uuid, p_transaction_date date,
  p_source_account_id text, p_destination_account_id text,
  p_source_amount numeric, p_destination_amount numeric, p_note text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  actor uuid := public.snacky_current_team_member_id();
  saved public.financial_transactions%rowtype;
  rate numeric;
  note_text text := nullif(btrim(coalesce(p_note,'')),'');
  replay boolean := false;
begin
  if actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance']) then
    raise exception 'Only active finance staff can record currency exchanges' using errcode='42501';
  end if;
  if p_client_submission_id is null then raise exception 'A saved request ID is required' using errcode='22023'; end if;
  if p_source_account_id is null or p_source_account_id not in ('snacky_lyd','owner_lyd') or p_destination_account_id is null or p_destination_account_id not in ('snacky_usd','owner_usd') then
    raise exception 'Choose a LYD source and a USD destination account' using errcode='22023';
  end if;
  if p_source_amount is null or p_destination_amount is null or p_source_amount<=0 or p_destination_amount<=0 or p_source_amount>=10000000000 or p_destination_amount>=10000000000 or p_source_amount<>round(p_source_amount,2) or p_destination_amount<>round(p_destination_amount,2) then
    raise exception 'Actual LYD and USD amounts must be positive and have at most two decimals' using errcode='22023';
  end if;
  rate := p_source_amount/p_destination_amount;
  if rate<0.000001 or rate>=1000000 then raise exception 'Check the two amounts and exchange rate' using errcode='22023'; end if;
  if p_transaction_date is null or p_transaction_date<=date '2026-05-15' or p_transaction_date>(now() at time zone 'Africa/Tripoli')::date then
    raise exception 'Use an exchange date after the opening-balance cutoff and not in the future' using errcode='22023';
  end if;
  if length(coalesce(note_text,''))>2000 then raise exception 'The note is too long' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('snacky-fx:'||p_client_submission_id::text,0));
  select * into saved from public.financial_transactions where id=p_client_submission_id;
  if found then
    if saved.source_type is distinct from 'currency_exchange' or saved.created_by is distinct from actor
      or saved.transaction_date is distinct from p_transaction_date or saved.source_account_id is distinct from p_source_account_id
      or saved.destination_account_id is distinct from p_destination_account_id or saved.amount is distinct from p_source_amount
      or saved.transfer_destination_amount is distinct from p_destination_amount or saved.notes is distinct from note_text then
      raise exception 'This saved request already belongs to different details. Review its history.' using errcode='23505';
    end if;
    replay := true;
  else
    insert into public.financial_transactions (
      id, transaction_date, transaction_datetime, direction, transaction_kind, transaction_type,
      amount, signed_amount, currency, account_id, account_key, transaction_effect,
      source_account_id, destination_account_id, transfer_destination_amount, exchange_rate_usd_to_lyd,
      category, bucket, final_bucket, description, notes, transaction_status, import_status,
      review_status, needs_review, is_void, source_type, source_id, created_by, metadata
    ) values (
      p_client_submission_id,p_transaction_date,p_transaction_date::timestamp at time zone 'Africa/Tripoli','money_out','manual_money_out','Currency Exchange',
      p_source_amount,-p_source_amount,'LYD',p_source_account_id,p_source_account_id,'transfer',
      p_source_account_id,p_destination_account_id,p_destination_amount,round(rate,6),
      'Currency Exchange','Transfer','Transfer',
      p_source_amount::text||' LYD → '||p_destination_amount::text||' USD; 1 USD = '||round(rate,6)::text||' LYD',
      note_text,'active','confirmed','confirmed',false,false,'currency_exchange',p_client_submission_id,actor,
      jsonb_build_object('command','currency_exchange_v1','client_submission_id',p_client_submission_id,'rate_basis','actual_paid_and_received')
    ) returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'amount',saved.amount,'destination_amount',saved.transfer_destination_amount,
    'source_account_id',saved.source_account_id,'destination_account_id',saved.destination_account_id,
    'exchange_rate_usd_to_lyd',saved.exchange_rate_usd_to_lyd,'transaction_status',saved.transaction_status,'already_applied',replay);
end $$;
revoke all on function public.snacky_record_currency_exchange_v1(uuid,date,text,text,numeric,numeric,text) from public,anon;
grant execute on function public.snacky_record_currency_exchange_v1(uuid,date,text,text,numeric,numeric,text) to authenticated;

-- Normal void/archive actions affect the one transfer, therefore both sides.
-- Amount/account edits must not turn a saved exchange into a one-sided expense.
create or replace function public.snacky_protect_currency_exchange_values()
returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
  if old.source_type='currency_exchange' and
    row(new.id,new.transaction_date,new.direction,new.amount,new.signed_amount,new.currency,new.account_id,new.transaction_effect,new.source_account_id,new.destination_account_id,new.transfer_destination_amount,new.exchange_rate_usd_to_lyd,new.source_type,new.source_id,new.created_by)
    is distinct from
    row(old.id,old.transaction_date,old.direction,old.amount,old.signed_amount,old.currency,old.account_id,old.transaction_effect,old.source_account_id,old.destination_account_id,old.transfer_destination_amount,old.exchange_rate_usd_to_lyd,old.source_type,old.source_id,old.created_by) then
    raise exception 'Void the incorrect exchange and record a replacement; its two amounts cannot be edited independently' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists snacky_protect_currency_exchange_values on public.financial_transactions;
create trigger snacky_protect_currency_exchange_values before update on public.financial_transactions for each row execute function public.snacky_protect_currency_exchange_values();

-- Preserve the existing cutoff, opening balances, filtering, columns, and RLS.
-- Only the destination projection changes; no historical money rows are edited.
do $$
declare definition text;
begin
  definition := pg_get_viewdef('public.finance_account_balance_impacts'::regclass,true);
  if position('transfer_destination_amount' in definition)=0 then
    if position('abs(ft.amount) AS amount_delta' in definition)=0 then
      raise exception 'Currency exchange migration needs review: unknown destination balance projection';
    end if;
    definition := replace(definition,'abs(ft.amount) AS amount_delta','CASE WHEN right(ft.source_account_id,3) <> right(ft.destination_account_id,3) THEN ft.transfer_destination_amount ELSE abs(ft.amount) END AS amount_delta');
    execute 'create or replace view public.finance_account_balance_impacts with (security_invoker=true) as '||definition;
  end if;
end $$;
notify pgrst,'reload schema';
