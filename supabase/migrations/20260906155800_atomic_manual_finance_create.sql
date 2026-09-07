-- Make generic manual finance creation an authenticated, exactly-once command.
--
-- Financial transactions remain readable through RLS, but clients no longer
-- mutate the ledger table directly. Audited server workflows (finance import,
-- payroll, and cash synchronization) use the server-only service client. A
-- supplier payment must use record_purchase_payment instead of masquerading as
-- a generic manual finance row linked to a purchase.

create table if not exists public.manual_finance_create_submissions (
  client_submission_id uuid primary key,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null
    check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  financial_transaction_id uuid unique
    references public.financial_transactions(id) on delete restrict,
  result_payload jsonb
    check (result_payload is null or pg_catalog.jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint manual_finance_create_submissions_completion_check
    check (
      (financial_transaction_id is null and result_payload is null and completed_at is null)
      or
      (financial_transaction_id is not null and result_payload is not null and completed_at is not null)
    )
);

create index if not exists manual_finance_create_submissions_actor_idx
  on public.manual_finance_create_submissions(actor_user_id, created_at desc);

alter table public.manual_finance_create_submissions enable row level security;
revoke all on table public.manual_finance_create_submissions
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_manual_finance_create_submission_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'Manual finance command receipts cannot be deleted.'
      using errcode = '23514';
  end if;

  if old.client_submission_id is distinct from new.client_submission_id
    or old.actor_user_id is distinct from new.actor_user_id
    or old.actor_team_member_id is distinct from new.actor_team_member_id
    or old.request_payload is distinct from new.request_payload
    or old.created_at is distinct from new.created_at
  then
    raise exception 'Manual finance command requests are immutable.'
      using errcode = '23514';
  end if;

  if old.financial_transaction_id is not null
    or old.result_payload is not null
    or old.completed_at is not null
  then
    raise exception 'Completed manual finance command results are immutable.'
      using errcode = '23514';
  end if;

  if new.financial_transaction_id is null
    or new.result_payload is null
    or new.completed_at is null
  then
    raise exception 'Manual finance command completion must be written atomically.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.snacky_guard_manual_finance_create_submission_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_manual_finance_create_submissions_immutable
  on public.manual_finance_create_submissions;
create trigger snacky_manual_finance_create_submissions_immutable
before update or delete on public.manual_finance_create_submissions
for each row
execute function public.snacky_guard_manual_finance_create_submission_immutable();
alter table public.manual_finance_create_submissions
  enable always trigger snacky_manual_finance_create_submissions_immutable;

create or replace function public.snacky_create_manual_finance_transaction_v1(
  p_client_submission_id uuid,
  p_transaction_date date,
  p_direction text,
  p_amount numeric,
  p_account_id text,
  p_source_account_id text,
  p_destination_account_id text,
  p_category text,
  p_transaction_type text,
  p_location text,
  p_description text,
  p_notes text,
  p_payment_method text,
  p_payer_text text,
  p_payee_text text,
  p_counterparty_text text,
  p_bucket text,
  p_related_route_id uuid,
  p_related_machine_id uuid,
  p_related_location_id uuid,
  p_receipt_url text
)
returns public.financial_transactions
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_submission public.manual_finance_create_submissions%rowtype;
  v_transaction public.financial_transactions%rowtype;
  v_flow_direction text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_direction, '')), ''));
  v_db_direction text;
  v_transaction_effect text;
  v_transaction_kind text;
  v_amount numeric(14,2);
  v_account_id text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_account_id, '')), ''));
  v_source_account_id text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_source_account_id, '')), ''));
  v_destination_account_id text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_destination_account_id, '')), ''));
  v_currency text;
  v_category text := nullif(pg_catalog.btrim(coalesce(p_category, '')), '');
  v_category_type text;
  v_category_id uuid;
  v_transaction_type text := nullif(pg_catalog.btrim(coalesce(p_transaction_type, '')), '');
  v_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  v_description text := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_payment_method text := nullif(pg_catalog.btrim(coalesce(p_payment_method, '')), '');
  v_payer_text text := nullif(pg_catalog.btrim(coalesce(p_payer_text, '')), '');
  v_payee_text text := nullif(pg_catalog.btrim(coalesce(p_payee_text, '')), '');
  v_counterparty_text text := nullif(pg_catalog.btrim(coalesce(p_counterparty_text, '')), '');
  v_bucket text := nullif(pg_catalog.btrim(coalesce(p_bucket, '')), '');
  v_receipt_url text := nullif(pg_catalog.btrim(coalesce(p_receipt_url, '')), '');
  v_request_payload jsonb;
  v_result_payload jsonb;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'finance']
  ) then
    raise exception 'Only owner, admin, supervisor, or finance can create finance transactions.'
      using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'The authenticated user is not linked to an active team member.'
      using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'A stable finance submission id is required.' using errcode = '22023';
  end if;
  if p_transaction_date is null then
    raise exception 'Transaction date is required.' using errcode = '22023';
  end if;

  v_amount := pg_catalog.round(p_amount, 2)::numeric(14,2);
  if v_amount is null
    or v_amount::text in ('NaN', 'Infinity', '-Infinity')
    or v_amount <= 0
  then
    raise exception 'Amount must be greater than zero.' using errcode = '22023';
  end if;

  if v_flow_direction not in ('money_in', 'money_out', 'transfer') then
    raise exception 'Direction must be money in, money out, or transfer.'
      using errcode = '22023';
  end if;

  if v_flow_direction = 'transfer' then
    if v_source_account_id not in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
      or v_destination_account_id not in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
      or v_source_account_id = v_destination_account_id
    then
      raise exception 'Transfer source and destination accounts are required and must be different.'
        using errcode = '22023';
    end if;
    if pg_catalog.right(v_source_account_id, 3) is distinct from pg_catalog.right(v_destination_account_id, 3) then
      raise exception 'Cross-currency transfers require a separate exchange workflow.'
        using errcode = '23514';
    end if;
    v_account_id := v_source_account_id;
    v_currency := case when pg_catalog.right(v_source_account_id, 3) = 'usd' then 'USD' else 'LYD' end;
    v_db_direction := 'money_out';
    v_transaction_effect := 'transfer';
    v_transaction_kind := 'manual_money_out';
    v_category := 'Transfer';
    v_payer_text := null;
    v_payee_text := null;
  else
    if v_account_id not in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd') then
      raise exception 'A valid finance account is required.' using errcode = '22023';
    end if;
    v_source_account_id := null;
    v_destination_account_id := null;
    v_currency := case when pg_catalog.right(v_account_id, 3) = 'usd' then 'USD' else 'LYD' end;
    v_db_direction := v_flow_direction;
    v_transaction_effect := case when v_flow_direction = 'money_in' then 'income' else 'expense' end;
    v_transaction_kind := case when v_flow_direction = 'money_in' then 'manual_money_in' else 'manual_money_out' end;
    if v_flow_direction = 'money_in' then
      v_payer_text := coalesce(v_payer_text, v_counterparty_text);
      v_payee_text := null;
      v_counterparty_text := coalesce(v_payer_text, v_counterparty_text);
    else
      v_payee_text := coalesce(v_payee_text, v_counterparty_text);
      v_payer_text := null;
      v_counterparty_text := coalesce(v_payee_text, v_counterparty_text);
    end if;
  end if;

  if v_category is null or pg_catalog.length(v_category) > 200 then
    raise exception 'Category is required and must be 200 characters or fewer.'
      using errcode = '22023';
  end if;
  v_category_type := case
    when v_transaction_effect = 'income' then 'income'
    when v_transaction_effect = 'transfer' then 'transfer'
    else 'expense'
  end;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'actor_user_id', v_actor_user_id,
    'actor_team_member_id', v_actor_team_member_id,
    'transaction_date', p_transaction_date,
    'flow_direction', v_flow_direction,
    'amount', v_amount,
    'currency', v_currency,
    'account_id', v_account_id,
    'source_account_id', v_source_account_id,
    'destination_account_id', v_destination_account_id,
    'category', v_category,
    'transaction_type', v_transaction_type,
    'location', v_location,
    'description', v_description,
    'notes', v_notes,
    'payment_method', v_payment_method,
    'payer_text', v_payer_text,
    'payee_text', v_payee_text,
    'counterparty_text', v_counterparty_text,
    'bucket', v_bucket,
    'related_route_id', p_related_route_id,
    'related_machine_id', p_related_machine_id,
    'related_location_id', p_related_location_id,
    'receipt_url', v_receipt_url
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:manual-finance-create:' || p_client_submission_id::text,
      0
    )
  );

  insert into public.manual_finance_create_submissions (
    client_submission_id,
    actor_user_id,
    actor_team_member_id,
    request_payload
  ) values (
    p_client_submission_id,
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload
  )
  on conflict (client_submission_id) do nothing;

  select submission.*
  into v_submission
  from public.manual_finance_create_submissions submission
  where submission.client_submission_id = p_client_submission_id
  for update;
  if not found then
    raise exception 'Manual finance command receipt could not be locked.'
      using errcode = '40001';
  end if;

  if v_submission.actor_user_id is distinct from v_actor_user_id
    or v_submission.actor_team_member_id is distinct from v_actor_team_member_id
    or v_submission.request_payload is distinct from v_request_payload
  then
    raise exception 'This finance submission id belongs to another actor or immutable request.'
      using errcode = '23505';
  end if;

  if v_submission.result_payload is not null then
    if v_submission.financial_transaction_id is null or v_submission.completed_at is null then
      raise exception 'The saved manual finance result is incomplete.'
        using errcode = '23514';
    end if;

    select finance.*
    into v_transaction
    from public.financial_transactions finance
    where finance.id = v_submission.financial_transaction_id
    for update;
    if not found
      or (v_submission.result_payload ->> 'id')::uuid is distinct from v_submission.financial_transaction_id
      or v_transaction.source_type is distinct from 'manual'
      or v_transaction.source_id is distinct from p_client_submission_id
      or v_transaction.created_by is distinct from v_actor_team_member_id
      or v_transaction.transaction_kind is distinct from (v_submission.result_payload ->> 'transaction_kind')
      or v_transaction.created_at is distinct from (v_submission.result_payload ->> 'created_at')::timestamptz
      or v_transaction.related_purchase_id is not null
      or v_transaction.linked_purchase_id is not null
      or v_transaction.metadata ->> 'client_submission_id' is distinct from p_client_submission_id::text
      or v_transaction.metadata ->> 'actor_user_id' is distinct from v_actor_user_id::text
    then
      raise exception 'The saved manual finance identity no longer matches the finance ledger.'
        using errcode = '23514';
    end if;

    return pg_catalog.jsonb_populate_record(
      null::public.financial_transactions,
      v_submission.result_payload
    );
  end if;
  if v_submission.financial_transaction_id is not null or v_submission.completed_at is not null then
    raise exception 'The saved manual finance command receipt is incomplete.'
      using errcode = '23514';
  end if;

  insert into public.finance_categories (name, type, is_active)
  values (v_category, v_category_type, true)
  on conflict (name) do nothing;

  select category.id, category.type
  into v_category_id, v_category_type
  from public.finance_categories category
  where category.name = v_category
  for update;
  if not found
    or v_category_type not in (
      case when v_transaction_effect = 'income' then 'income'
           when v_transaction_effect = 'transfer' then 'transfer'
           else 'expense'
      end,
      'both'
    )
  then
    raise exception 'The selected category does not match the money direction.'
      using errcode = '23514';
  end if;

  update public.finance_categories
  set is_active = true
  where id = v_category_id
    and not is_active;

  insert into public.financial_transactions (
    transaction_date,
    transaction_datetime,
    direction,
    transaction_kind,
    transaction_type,
    location,
    description,
    notes,
    payment_method,
    amount,
    signed_amount,
    currency,
    account_id,
    account_key,
    transaction_effect,
    source_account_id,
    destination_account_id,
    finance_category_id,
    payer_text,
    payee_text,
    paid_to_text,
    counterparty_text,
    bucket,
    category,
    final_bucket,
    review_status,
    needs_review,
    transaction_status,
    related_purchase_id,
    linked_purchase_id,
    related_route_id,
    related_machine_id,
    related_location_id,
    receipt_url,
    source_type,
    source_id,
    created_by,
    metadata,
    is_void,
    updated_at
  ) values (
    p_transaction_date,
    p_transaction_date::timestamp at time zone 'UTC' + interval '12 hours',
    v_db_direction,
    v_transaction_kind,
    v_transaction_type,
    v_location,
    coalesce(v_description, v_counterparty_text),
    v_notes,
    v_payment_method,
    v_amount,
    case when v_db_direction = 'money_out' then -v_amount else v_amount end,
    v_currency,
    v_account_id,
    v_account_id,
    v_transaction_effect,
    v_source_account_id,
    v_destination_account_id,
    v_category_id,
    v_payer_text,
    v_payee_text,
    v_payee_text,
    v_counterparty_text,
    v_bucket,
    v_category,
    v_category,
    'confirmed',
    false,
    'active',
    null,
    null,
    p_related_route_id,
    p_related_machine_id,
    p_related_location_id,
    v_receipt_url,
    'manual',
    p_client_submission_id,
    v_actor_team_member_id,
    pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'client_submission_id', p_client_submission_id,
      'actor_user_id', v_actor_user_id
    ),
    false,
    pg_catalog.now()
  )
  returning * into v_transaction;

  v_result_payload := pg_catalog.to_jsonb(v_transaction);
  update public.manual_finance_create_submissions
  set
    financial_transaction_id = v_transaction.id,
    result_payload = v_result_payload,
    completed_at = pg_catalog.now()
  where client_submission_id = p_client_submission_id;
  if not found then
    raise exception 'Manual finance command completion could not be saved.'
      using errcode = '40001';
  end if;

  return v_transaction;
end;
$function$;

revoke all on function public.snacky_create_manual_finance_transaction_v1(
  uuid, date, text, numeric, text, text, text, text, text, text, text, text,
  text, text, text, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_create_manual_finance_transaction_v1(
  uuid, date, text, numeric, text, text, text, text, text, text, text, text,
  text, text, text, text, text, uuid, uuid, uuid, text
) to authenticated;

comment on function public.snacky_create_manual_finance_transaction_v1(
  uuid, date, text, numeric, text, text, text, text, text, text, text, text,
  text, text, text, text, text, uuid, uuid, uuid, text
) is 'Authenticated exactly-once manual finance command. It cannot link or settle a purchase; supplier payments use record_purchase_payment.';

-- A signed-in client may read finance through RLS, but every mutation must use
-- an authenticated command or one of the audited server-only service writers.
drop policy if exists "financial_transactions_insert_finance_roles"
  on public.financial_transactions;
drop policy if exists "financial_transactions_update_finance_roles"
  on public.financial_transactions;
revoke insert, update, delete on table public.financial_transactions
  from public, anon, authenticated;
grant insert, update, delete on table public.financial_transactions
  to service_role;

select pg_catalog.pg_notify('pgrst', 'reload schema');
