-- Make supplier-payment recording a serialized, exactly-once money command.
-- The existing API signature is preserved for the application, but every new
-- request is bound to its authenticated actor, normalized payload, payment row,
-- and exact immutable result.

create table if not exists public.purchase_payment_submissions (
  client_submission_id text primary key,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  payment_id uuid unique references public.purchase_payments(id) on delete restrict,
  result_payload jsonb check (
    result_payload is null or pg_catalog.jsonb_typeof(result_payload) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint purchase_payment_submissions_nonblank
    check (nullif(pg_catalog.btrim(client_submission_id), '') is not null),
  constraint purchase_payment_submissions_completion_check
    check (
      (payment_id is null and result_payload is null and completed_at is null)
      or
      (payment_id is not null and result_payload is not null and completed_at is not null)
    )
);

create index if not exists purchase_payment_submissions_purchase_idx
  on public.purchase_payment_submissions(purchase_order_id, created_at desc);

alter table public.purchase_payment_submissions enable row level security;
revoke all on table public.purchase_payment_submissions
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_purchase_payment_submission_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'Supplier payment command receipts cannot be deleted.' using errcode = '23514';
  end if;

  if old.client_submission_id is distinct from new.client_submission_id
    or old.purchase_order_id is distinct from new.purchase_order_id
    or old.actor_user_id is distinct from new.actor_user_id
    or old.actor_team_member_id is distinct from new.actor_team_member_id
    or old.request_payload is distinct from new.request_payload
    or old.created_at is distinct from new.created_at
  then
    raise exception 'Supplier payment command requests are immutable.' using errcode = '23514';
  end if;

  if old.completed_at is not null
    or old.payment_id is not null
    or old.result_payload is not null
  then
    raise exception 'Completed supplier payment command results are immutable.' using errcode = '23514';
  end if;

  if new.completed_at is null
    or new.payment_id is null
    or new.result_payload is null
  then
    raise exception 'Supplier payment command completion must be written atomically.' using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.snacky_guard_purchase_payment_submission_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_payment_submissions_immutable
  on public.purchase_payment_submissions;
create trigger snacky_purchase_payment_submissions_immutable
before update or delete on public.purchase_payment_submissions
for each row
execute function public.snacky_guard_purchase_payment_submission_immutable();

-- A finance row owned by a supplier payment is a projection of that payment,
-- not an independently editable ledger entry. Only the canonical payment
-- functions may open the transaction-local gate for that exact payment id.
create or replace function public.snacky_guard_purchase_payment_finance_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_is_protected boolean := false;
  v_payment public.purchase_payments%rowtype;
  v_owner_name text;
  v_marker text := nullif(
    pg_catalog.current_setting('snacky.purchase_payment_finance_write_id', true),
    ''
  );
begin
  if tg_op = 'INSERT' then
    v_is_protected := new.source_type = 'purchase_payment';
    if v_is_protected then
      select payment.*
      into v_payment
      from public.purchase_payments payment
      where payment.id = new.source_id;
    end if;
  elsif tg_op = 'UPDATE' then
    v_is_protected := old.source_type = 'purchase_payment'
      or new.source_type = 'purchase_payment'
      or exists (
        select 1
        from public.purchase_payments payment
        where payment.finance_transaction_id = old.id
      );
    if v_is_protected then
      select payment.*
      into v_payment
      from public.purchase_payments payment
      where payment.finance_transaction_id = old.id
        or (
          old.source_type = 'purchase_payment'
          and payment.id = old.source_id
        )
        or (
          new.source_type = 'purchase_payment'
          and payment.id = new.source_id
        )
      order by case when payment.finance_transaction_id = old.id then 0 else 1 end
      limit 1;
    end if;
  else
    v_is_protected := old.source_type = 'purchase_payment';
    if not v_is_protected then
      v_is_protected := exists (
        select 1
        from public.purchase_payments payment
        where payment.finance_transaction_id = old.id
      );
    end if;
    if v_is_protected then
      select payment.*
      into v_payment
      from public.purchase_payments payment
      where payment.finance_transaction_id = old.id
        or (old.source_type = 'purchase_payment' and payment.id = old.source_id)
      order by case when payment.finance_transaction_id = old.id then 0 else 1 end
      limit 1;
    end if;
  end if;

  if v_is_protected then
    select pg_catalog.pg_get_userbyid(class.relowner)::text
    into v_owner_name
    from pg_catalog.pg_class class
    where class.oid = 'public.financial_transactions'::pg_catalog.regclass;

    if v_payment.id is null or current_user::text is distinct from v_owner_name then
      raise exception 'Supplier-payment finance rows are managed from the purchase payment workflow.'
        using errcode = '42501';
    end if;

    if tg_op = 'INSERT' then
      if v_marker is distinct from 'record:' || v_payment.id::text
        or v_payment.finance_transaction_id is not null
        or new.source_type is distinct from 'purchase_payment'
        or new.source_id is distinct from v_payment.id
        or new.transaction_kind is distinct from 'product_purchase'
        or new.direction is distinct from 'money_out'
        or pg_catalog.round(new.amount::numeric, 2) is distinct from v_payment.amount_lyd
        or pg_catalog.round(new.signed_amount::numeric, 2) is distinct from -v_payment.amount_lyd
        or new.currency is distinct from v_payment.currency
        or new.account_id is distinct from v_payment.account_id
        or new.payment_method is distinct from v_payment.payment_method
        or new.transaction_datetime is distinct from v_payment.paid_at
        or new.transaction_date is distinct from (v_payment.paid_at at time zone 'Africa/Tripoli')::date
        or new.created_by is distinct from v_payment.recorded_by
        or new.transaction_status is distinct from 'active'
        or coalesce(new.is_void, false) is distinct from false
      then
        raise exception 'Canonical supplier-payment finance insert does not match its payment row.'
          using errcode = '23514';
      end if;
    elsif tg_op = 'UPDATE' then
      if v_marker is distinct from 'void:' || v_payment.id::text
        or v_payment.voided_at is null
        or new.source_type is distinct from old.source_type
        or new.source_id is distinct from old.source_id
        or new.transaction_status is distinct from 'voided'
        or coalesce(new.is_void, false) is distinct from true
        or new.voided_at is distinct from v_payment.voided_at
        or new.voided_by is distinct from v_payment.voided_by
        or new.void_reason is distinct from v_payment.void_reason
        or (
          pg_catalog.to_jsonb(new)
            - array['transaction_status', 'is_void', 'voided_at', 'voided_by', 'void_reason', 'updated_at']::text[]
        ) is distinct from (
          pg_catalog.to_jsonb(old)
            - array['transaction_status', 'is_void', 'voided_at', 'voided_by', 'void_reason', 'updated_at']::text[]
        )
      then
        raise exception 'Canonical supplier-payment finance void changed fields outside its payment state.'
          using errcode = '23514';
      end if;
    else
      raise exception 'Supplier-payment finance rows cannot be deleted.' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.snacky_guard_purchase_payment_finance_row()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_payment_finance_row_guard
  on public.financial_transactions;
create trigger snacky_purchase_payment_finance_row_guard
before insert or update or delete on public.financial_transactions
for each row
execute function public.snacky_guard_purchase_payment_finance_row();
alter table public.financial_transactions
  enable always trigger snacky_purchase_payment_finance_row_guard;

create or replace function public.record_purchase_payment(
  p_purchase_order_id uuid,
  p_amount numeric,
  p_paid_at timestamptz,
  p_payment_method text,
  p_account_id text,
  p_reference text,
  p_note text,
  p_client_submission_id text
)
returns public.purchase_payments
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_purchase public.purchase_orders%rowtype;
  v_submission public.purchase_payment_submissions%rowtype;
  v_payment public.purchase_payments%rowtype;
  v_finance public.financial_transactions%rowtype;
  v_line_lock record;
  v_amount numeric(14,2);
  v_paid_at timestamptz := p_paid_at;
  v_payment_method text;
  v_account_id text;
  v_reference text := nullif(pg_catalog.btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_total numeric(14,2);
  v_paid numeric(14,2);
  v_remaining numeric(14,2);
  v_supplier text;
  v_finance_id uuid;
  v_status text;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can record supplier payments'
      using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'The authenticated user is not linked to an active team member.'
      using errcode = '42501';
  end if;
  if p_purchase_order_id is null then
    raise exception 'Purchase is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable payment submission id between 1 and 200 characters is required.'
      using errcode = '22023';
  end if;

  v_amount := pg_catalog.round(p_amount, 2)::numeric(14,2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = '22023';
  end if;
  if v_paid_at is null then
    raise exception 'Payment date is required.' using errcode = '22023';
  end if;

  -- Purchase is the parent mutex for both balance calculation and every retry.
  -- No idempotency lookup or remaining-balance read is allowed before it.
  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_order_id
  for update;
  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;

  -- Purchase lifecycle commands use this same parent -> sorted line order.
  -- The accounting assertion below must never inspect unlocked line inputs.
  for v_line_lock in
    select line.id
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_order_id
    order by line.product_id, line.line_position, line.id
    for update
  loop
    null;
  end loop;

  v_payment_method := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_payment_method, '')), ''),
    'cash'
  );
  v_account_id := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_account_id, '')), ''),
    'snacky_lyd'
  );
  if v_account_id not in ('snacky_lyd', 'owner_lyd') then
    raise exception 'Supplier payments currently support LYD accounts only; record FX conversion separately before enabling USD'
      using errcode = '23514';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'purchase_order_id', p_purchase_order_id,
    'amount_lyd', v_amount,
    'paid_at', v_paid_at,
    'payment_method', v_payment_method,
    'account_id', v_account_id,
    'reference', v_reference,
    'note', v_note,
    'actor_user_id', v_actor_user_id,
    'actor_team_member_id', v_actor_team_member_id
  );

  -- A reused key across different purchases serializes here even though those
  -- purchases use different row locks. The unique row is also the exact retry
  -- receipt for identical concurrent requests.
  insert into public.purchase_payment_submissions (
    client_submission_id,
    purchase_order_id,
    actor_user_id,
    actor_team_member_id,
    request_payload
  ) values (
    v_submission_id,
    p_purchase_order_id,
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload
  )
  on conflict (client_submission_id) do nothing;

  select submission.*
  into v_submission
  from public.purchase_payment_submissions submission
  where submission.client_submission_id = v_submission_id
  for update;
  if not found then
    raise exception 'Supplier payment command receipt could not be locked.' using errcode = '40001';
  end if;

  if v_submission.purchase_order_id is distinct from p_purchase_order_id
    or v_submission.actor_user_id is distinct from v_actor_user_id
    or v_submission.actor_team_member_id is distinct from v_actor_team_member_id
    or v_submission.request_payload is distinct from v_request_payload
  then
    raise exception 'This payment submission id belongs to another actor or immutable request.'
      using errcode = '23505';
  end if;

  if v_submission.result_payload is not null then
    if v_submission.payment_id is null or v_submission.completed_at is null then
      raise exception 'The saved supplier payment result is incomplete.' using errcode = '23514';
    end if;

    select payment.*
    into v_payment
    from public.purchase_payments payment
    where payment.id = v_submission.payment_id
    for update;
    if not found
      or (
        pg_catalog.to_jsonb(v_payment)
          - array['voided_at', 'voided_by', 'void_reason']::text[]
      ) is distinct from (
        v_submission.result_payload
          - array['voided_at', 'voided_by', 'void_reason']::text[]
      )
    then
      raise exception 'The saved supplier payment identity no longer matches the payment ledger.'
        using errcode = '23514';
    end if;

    select finance.*
    into v_finance
    from public.financial_transactions finance
    where finance.id = v_payment.finance_transaction_id
    for update;
    if not found
      or v_finance.source_type is distinct from 'purchase_payment'
      or v_finance.source_id is distinct from v_payment.id
      or v_finance.direction is distinct from 'money_out'
      or v_finance.transaction_kind is distinct from 'product_purchase'
      or pg_catalog.round(v_finance.amount::numeric, 2) is distinct from v_payment.amount_lyd
      or pg_catalog.round(v_finance.signed_amount::numeric, 2) is distinct from -v_payment.amount_lyd
      or v_finance.account_id is distinct from v_payment.account_id
      or v_finance.currency is distinct from v_payment.currency
      or v_finance.payment_method is distinct from v_payment.payment_method
      or v_finance.transaction_datetime is distinct from v_payment.paid_at
      or v_payment.recorded_by is null
      or v_finance.created_by is distinct from v_payment.recorded_by
      or (
        v_payment.voided_at is null
        and (
          v_finance.transaction_status is distinct from 'active'
          or coalesce(v_finance.is_void, false) is distinct from false
        )
      )
      or (
        v_payment.voided_at is not null
        and (
          v_finance.transaction_status is distinct from 'voided'
          or coalesce(v_finance.is_void, false) is distinct from true
          or v_finance.voided_at is distinct from v_payment.voided_at
          or v_finance.voided_by is distinct from v_payment.voided_by
          or v_finance.void_reason is distinct from v_payment.void_reason
        )
      )
    then
      raise exception 'The saved supplier payment finance entry is incomplete or inconsistent.'
        using errcode = '23514';
    end if;

    return pg_catalog.jsonb_populate_record(
      null::public.purchase_payments,
      v_submission.result_payload
    );
  end if;

  if v_submission.payment_id is not null or v_submission.completed_at is not null then
    raise exception 'The saved supplier payment command receipt is incomplete.' using errcode = '23514';
  end if;

  -- A pre-V2 payment row cannot prove the authenticated user identity. Refuse
  -- ambiguous legacy key reuse instead of silently claiming it as this request.
  perform 1
  from public.purchase_payments payment
  where payment.client_submission_id = v_submission_id
  for update;
  if found then
    raise exception 'This payment submission id already exists without an exact V2 command receipt. Review it before retrying.'
      using errcode = '23505';
  end if;

  if v_purchase.status <> 'received' or v_purchase.payment_status = 'voided' then
    raise exception 'Only a received, non-void purchase can be paid' using errcode = '23514';
  end if;

  v_total := public._snacky_assert_purchase_accounting_v1(
    p_purchase_order_id
  )::numeric(14,2);

  select pg_catalog.round(coalesce(pg_catalog.sum(payment.amount_lyd), 0), 2)::numeric(14,2)
  into v_paid
  from public.purchase_payments payment
  where payment.purchase_order_id = p_purchase_order_id
    and payment.voided_at is null;

  v_remaining := greatest(v_total - v_paid, 0)::numeric(14,2);
  if v_amount > v_remaining then
    raise exception 'Payment exceeds the remaining supplier balance' using errcode = '23514';
  end if;

  insert into public.purchase_payments (
    purchase_order_id,
    amount_lyd,
    paid_at,
    payment_method,
    account_id,
    currency,
    reference,
    note,
    client_submission_id,
    recorded_by
  ) values (
    p_purchase_order_id,
    v_amount,
    v_paid_at,
    v_payment_method,
    v_account_id,
    'LYD',
    v_reference,
    v_note,
    v_submission_id,
    v_actor_team_member_id
  )
  returning * into v_payment;

  select nullif(pg_catalog.btrim(coalesce(supplier.name, '')), '')
  into v_supplier
  from public.suppliers supplier
  where supplier.id = v_purchase.supplier_id;

  perform pg_catalog.set_config(
    'snacky.purchase_payment_finance_write_id',
    'record:' || v_payment.id::text,
    true
  );

  insert into public.financial_transactions (
    transaction_date,
    transaction_datetime,
    direction,
    transaction_kind,
    transaction_type,
    category,
    description,
    notes,
    amount,
    signed_amount,
    currency,
    account_id,
    account_key,
    transaction_effect,
    bucket,
    final_bucket,
    payment_method,
    receipt_url,
    import_status,
    transaction_status,
    review_status,
    needs_review,
    is_void,
    counterparty_text,
    paid_to_text,
    payee_text,
    source_type,
    source_id,
    created_by,
    updated_at
  ) values (
    (v_paid_at at time zone 'Africa/Tripoli')::date,
    v_paid_at,
    'money_out',
    'product_purchase',
    'Products Restocking',
    'Products Restocking',
    pg_catalog.concat_ws(
      ' - ',
      'Supplier payment to ' || coalesce(v_supplier, 'supplier'),
      case
        when nullif(pg_catalog.btrim(coalesce(v_purchase.receipt_number, '')), '') is not null
          then 'Receipt ' || v_purchase.receipt_number
      end
    ),
    pg_catalog.concat_ws(' / ', v_note, 'Purchase payment ' || v_payment.id::text),
    v_amount,
    -v_amount,
    'LYD',
    v_account_id,
    v_account_id,
    'expense',
    'Inventory',
    'Products Restocking',
    v_payment_method,
    v_purchase.receipt_url,
    'confirmed',
    'active',
    'confirmed',
    false,
    false,
    v_supplier,
    v_supplier,
    v_supplier,
    'purchase_payment',
    v_payment.id,
    v_actor_team_member_id,
    pg_catalog.now()
  )
  returning id into v_finance_id;

  perform pg_catalog.set_config(
    'snacky.purchase_payment_finance_write_id',
    '',
    true
  );

  update public.purchase_payments payment
  set finance_transaction_id = v_finance_id
  where payment.id = v_payment.id
  returning payment.* into v_payment;

  v_status := case
    when v_paid + v_amount >= v_total then 'paid'
    else 'partially_paid'
  end;

  update public.purchase_orders purchase
  set payment_status = v_status,
      payment_method = v_payment_method,
      payment_account_id = v_account_id,
      updated_at = pg_catalog.now()
  where purchase.id = p_purchase_order_id;

  v_result_payload := pg_catalog.to_jsonb(v_payment);
  update public.purchase_payment_submissions submission
  set payment_id = v_payment.id,
      result_payload = v_result_payload,
      completed_at = pg_catalog.now()
  where submission.client_submission_id = v_submission_id
    and submission.payment_id is null
    and submission.result_payload is null
    and submission.completed_at is null;
  if not found then
    raise exception 'Supplier payment result could not be recorded exactly once.' using errcode = '40001';
  end if;

  return v_payment;
end;
$function$;

create table if not exists public.purchase_payment_void_operations (
  client_submission_id text primary key,
  payment_id uuid not null unique references public.purchase_payments(id) on delete restrict,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  result_payload jsonb not null check (pg_catalog.jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  constraint purchase_payment_void_operations_nonblank
    check (nullif(pg_catalog.btrim(client_submission_id), '') is not null)
);

create index if not exists purchase_payment_void_operations_purchase_idx
  on public.purchase_payment_void_operations(purchase_order_id, created_at desc);

alter table public.purchase_payment_void_operations enable row level security;
revoke all on table public.purchase_payment_void_operations
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_purchase_payment_void_operation_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Completed supplier payment void command receipts are immutable.'
    using errcode = '23514';
end;
$function$;

revoke all on function public.snacky_guard_purchase_payment_void_operation_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_payment_void_operations_immutable
  on public.purchase_payment_void_operations;
create trigger snacky_purchase_payment_void_operations_immutable
before update or delete on public.purchase_payment_void_operations
for each row
execute function public.snacky_guard_purchase_payment_void_operation_immutable();

create or replace function public.snacky_void_purchase_payment_v1(
  p_purchase_payment_id uuid,
  p_reason text,
  p_client_submission_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_preflight_purchase_id uuid;
  v_purchase public.purchase_orders%rowtype;
  v_payment public.purchase_payments%rowtype;
  v_finance public.financial_transactions%rowtype;
  v_line_lock record;
  v_operation public.purchase_payment_void_operations%rowtype;
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_total numeric(14,2);
  v_paid numeric(14,2);
  v_remaining numeric(14,2);
  v_status text;
  v_latest_payment_method text;
  v_latest_account_id text;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'finance']) then
    raise exception 'Only owner, admin, or finance can void supplier payments.'
      using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'The authenticated user is not linked to an active team member.'
      using errcode = '42501';
  end if;
  if p_purchase_payment_id is null then
    raise exception 'Supplier payment is required.' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) > 2000 then
    raise exception 'A payment void reason between 1 and 2000 characters is required.'
      using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable payment void submission id between 1 and 200 characters is required.'
      using errcode = '22023';
  end if;

  select payment.purchase_order_id
  into v_preflight_purchase_id
  from public.purchase_payments payment
  where payment.id = p_purchase_payment_id;
  if not found then
    raise exception 'Supplier payment was not found.' using errcode = 'P0002';
  end if;

  -- Match payment recording: purchase parent first, then payment, then finance.
  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = v_preflight_purchase_id
  for update;
  if not found then
    raise exception 'Purchase was not found.' using errcode = 'P0002';
  end if;

  for v_line_lock in
    select line.id
    from public.purchase_order_lines line
    where line.purchase_order_id = v_purchase.id
    order by line.product_id, line.line_position, line.id
    for update
  loop
    null;
  end loop;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:purchase-payment-void:' || v_submission_id, 0)
  );

  select payment.*
  into v_payment
  from public.purchase_payments payment
  where payment.id = p_purchase_payment_id
  for update;
  if not found or v_payment.purchase_order_id is distinct from v_purchase.id then
    raise exception 'Supplier payment changed while it was being locked.' using errcode = '40001';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'payment_id', p_purchase_payment_id,
    'purchase_order_id', v_purchase.id,
    'reason', v_reason,
    'actor_user_id', v_actor_user_id,
    'actor_team_member_id', v_actor_team_member_id
  );

  select operation.*
  into v_operation
  from public.purchase_payment_void_operations operation
  where operation.client_submission_id = v_submission_id
  for update;
  if found then
    if v_operation.payment_id is distinct from p_purchase_payment_id
      or v_operation.purchase_order_id is distinct from v_purchase.id
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
    then
      raise exception 'This payment void submission id belongs to another actor or immutable request.'
        using errcode = '23505';
    end if;

    if pg_catalog.to_jsonb(v_payment) is distinct from (v_operation.result_payload -> 'payment') then
      raise exception 'The saved payment void result no longer matches the payment ledger.'
        using errcode = '23514';
    end if;
    select finance.*
    into v_finance
    from public.financial_transactions finance
    where finance.id = v_payment.finance_transaction_id
    for update;
    if not found
      or pg_catalog.to_jsonb(v_finance) is distinct from (v_operation.result_payload -> 'finance_transaction')
    then
      raise exception 'The saved payment void result no longer matches the finance ledger.'
        using errcode = '23514';
    end if;

    return v_operation.result_payload;
  end if;

  select operation.*
  into v_operation
  from public.purchase_payment_void_operations operation
  where operation.payment_id = p_purchase_payment_id
  for update;
  if found then
    raise exception 'This supplier payment was already voided with a different immutable request.'
      using errcode = '23505';
  end if;

  if v_purchase.status <> 'received' or v_purchase.payment_status = 'voided' then
    raise exception 'Supplier payment correction requires a received, non-void purchase.'
      using errcode = '23514';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'This supplier payment is already voided without an exact command receipt. Review it before retrying.'
      using errcode = '23514';
  end if;
  if v_payment.finance_transaction_id is null then
    raise exception 'This supplier payment has no linked finance row and must be reviewed before voiding.'
      using errcode = '23514';
  end if;

  select finance.*
  into v_finance
  from public.financial_transactions finance
  where finance.id = v_payment.finance_transaction_id
  for update;
  if not found
    or v_finance.direction is distinct from 'money_out'
    or v_finance.transaction_kind is distinct from 'product_purchase'
    or pg_catalog.round(v_finance.amount::numeric, 2) is distinct from v_payment.amount_lyd
    or pg_catalog.round(v_finance.signed_amount::numeric, 2) is distinct from -v_payment.amount_lyd
    or v_finance.account_id is distinct from v_payment.account_id
    or v_finance.currency is distinct from v_payment.currency
    or v_finance.payment_method is distinct from v_payment.payment_method
    or v_finance.transaction_datetime is distinct from v_payment.paid_at
    or v_payment.recorded_by is null
    or v_finance.created_by is distinct from v_payment.recorded_by
    or v_finance.transaction_status is distinct from 'active'
    or coalesce(v_finance.is_void, false) is distinct from false
    or not (
      (
        v_finance.source_type = 'purchase_payment'
        and v_finance.source_id = v_payment.id
      )
      or (
        v_finance.source_type = 'purchase'
        and v_finance.source_id = v_purchase.id
      )
    )
  then
    raise exception 'Supplier payment and finance rows are incomplete or inconsistent. Review them before voiding.'
      using errcode = '23514';
  end if;

  -- Reject malformed legacy purchase totals before changing either ledger.
  v_total := public._snacky_assert_purchase_accounting_v1(
    v_purchase.id
  )::numeric(14,2);

  update public.purchase_payments payment
  set voided_at = pg_catalog.now(),
      voided_by = v_actor_team_member_id,
      void_reason = v_reason
  where payment.id = p_purchase_payment_id
    and payment.voided_at is null
  returning payment.* into v_payment;
  if not found then
    raise exception 'Supplier payment changed while it was being voided.' using errcode = '40001';
  end if;

  perform pg_catalog.set_config(
    'snacky.purchase_payment_finance_write_id',
    'void:' || v_payment.id::text,
    true
  );

  update public.financial_transactions finance
  set transaction_status = 'voided',
      is_void = true,
      voided_at = v_payment.voided_at,
      voided_by = v_payment.voided_by,
      void_reason = v_payment.void_reason,
      updated_at = pg_catalog.now()
  where finance.id = v_payment.finance_transaction_id
    and finance.transaction_status = 'active'
    and coalesce(finance.is_void, false) = false
  returning finance.* into v_finance;
  if not found then
    raise exception 'Supplier payment finance row changed while it was being voided.' using errcode = '40001';
  end if;

  perform pg_catalog.set_config(
    'snacky.purchase_payment_finance_write_id',
    '',
    true
  );

  select pg_catalog.round(coalesce(pg_catalog.sum(payment.amount_lyd), 0), 2)::numeric(14,2)
  into v_paid
  from public.purchase_payments payment
  where payment.purchase_order_id = v_purchase.id
    and payment.voided_at is null;

  select payment.payment_method, payment.account_id
  into v_latest_payment_method, v_latest_account_id
  from public.purchase_payments payment
  where payment.purchase_order_id = v_purchase.id
    and payment.voided_at is null
  order by payment.paid_at desc, payment.created_at desc, payment.id desc
  limit 1;

  v_remaining := greatest(v_total - v_paid, 0)::numeric(14,2);
  v_status := case
    when v_paid <= 0 then 'unpaid'
    when v_total > 0 and v_paid >= v_total then 'paid'
    else 'partially_paid'
  end;

  update public.purchase_orders purchase
  set payment_status = v_status,
      payment_method = case
        when v_latest_payment_method is not null then v_latest_payment_method
        else 'cash'
      end,
      payment_account_id = case
        when v_latest_account_id is not null then v_latest_account_id
        else 'snacky_lyd'
      end,
      updated_at = pg_catalog.now()
  where purchase.id = v_purchase.id
  returning purchase.* into v_purchase;

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'payment_id', p_purchase_payment_id,
    'purchase_order_id', v_purchase.id,
    'payment', pg_catalog.to_jsonb(v_payment),
    'finance_transaction', pg_catalog.to_jsonb(v_finance),
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'paid_amount_lyd', v_paid,
    'remaining_amount_lyd', v_remaining,
    'payment_status', v_status,
    'already_applied', false
  );

  insert into public.purchase_payment_void_operations (
    client_submission_id,
    payment_id,
    purchase_order_id,
    actor_user_id,
    actor_team_member_id,
    request_payload,
    result_payload
  ) values (
    v_submission_id,
    p_purchase_payment_id,
    v_purchase.id,
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload,
    v_result_payload
  );

  return v_result_payload;
end;
$function$;

revoke all on function public.snacky_void_purchase_payment_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_void_purchase_payment_v1(uuid, text, text)
  to authenticated;

-- Preserve the old parent-status trigger for defensive legacy transitions, but
-- make every owned finance update pass through the same exact write gate.
create or replace function public.void_purchase_payment_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payment public.purchase_payments%rowtype;
  v_finance public.financial_transactions%rowtype;
begin
  if (new.status in ('cancelled', 'voided') or new.payment_status = 'voided')
    and not (
      old.status in ('cancelled', 'voided')
      or old.payment_status = 'voided'
    )
  then
    for v_payment in
      select payment.*
      from public.purchase_payments payment
      where payment.purchase_order_id = new.id
        and payment.voided_at is null
      order by payment.id
      for update
    loop
      if v_payment.finance_transaction_id is null then
        raise exception 'Supplier payment has no linked finance row and cannot follow a parent void.'
          using errcode = '23514';
      end if;

      select finance.*
      into v_finance
      from public.financial_transactions finance
      where finance.id = v_payment.finance_transaction_id
      for update;
      if not found
        or v_finance.direction is distinct from 'money_out'
        or v_finance.transaction_kind is distinct from 'product_purchase'
        or pg_catalog.round(v_finance.amount::numeric, 2) is distinct from v_payment.amount_lyd
        or pg_catalog.round(v_finance.signed_amount::numeric, 2) is distinct from -v_payment.amount_lyd
        or v_finance.account_id is distinct from v_payment.account_id
        or v_finance.currency is distinct from v_payment.currency
        or v_finance.payment_method is distinct from v_payment.payment_method
        or v_finance.transaction_datetime is distinct from v_payment.paid_at
        or v_payment.recorded_by is null
        or v_finance.created_by is distinct from v_payment.recorded_by
        or v_finance.transaction_status is distinct from 'active'
        or coalesce(v_finance.is_void, false) is distinct from false
        or not (
          (
            v_finance.source_type = 'purchase_payment'
            and v_finance.source_id = v_payment.id
          )
          or (
            v_finance.source_type = 'purchase'
            and v_finance.source_id = new.id
          )
        )
      then
        raise exception 'Supplier payment and finance rows must be consistent before a parent void.'
          using errcode = '23514';
      end if;

      update public.purchase_payments payment
      set voided_at = pg_catalog.now(),
          voided_by = coalesce(new.voided_by, public.snacky_current_team_member_id()),
          void_reason = coalesce(new.void_reason, 'Source purchase was voided')
      where payment.id = v_payment.id
      returning payment.* into v_payment;

      if v_payment.finance_transaction_id is not null then
        perform pg_catalog.set_config(
          'snacky.purchase_payment_finance_write_id',
          'void:' || v_payment.id::text,
          true
        );
        update public.financial_transactions finance
        set transaction_status = 'voided',
            is_void = true,
            voided_at = v_payment.voided_at,
            voided_by = v_payment.voided_by,
            void_reason = v_payment.void_reason,
            updated_at = pg_catalog.now()
        where finance.id = v_payment.finance_transaction_id
          and finance.transaction_status = 'active'
          and coalesce(finance.is_void, false) = false
        returning finance.* into v_finance;
        if not found then
          raise exception 'Linked supplier-payment finance row was not found.' using errcode = '23514';
        end if;
        perform pg_catalog.set_config(
          'snacky.purchase_payment_finance_write_id',
          '',
          true
        );
      end if;
    end loop;
  end if;
  return new;
end;
$function$;

revoke all on function public.void_purchase_payment_rows()
  from public, anon, authenticated, service_role;

revoke all on function public.record_purchase_payment(
  uuid, numeric, timestamptz, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_purchase_payment(
  uuid, numeric, timestamptz, text, text, text, text, text
) to authenticated;

comment on function public.record_purchase_payment(
  uuid, numeric, timestamptz, text, text, text, text, text
) is 'Authenticated serialized supplier-payment command. Amount is normalized to two decimals before balance/status writes; exact retries return one actor-bound immutable result.';

comment on function public.snacky_void_purchase_payment_v1(uuid, text, text)
is 'Authenticated exactly-once supplier-payment correction. Payment, owned finance row, and purchase settlement summary change atomically.';

revoke all on table public.purchase_payments
  from public, anon, authenticated, service_role;
grant select on table public.purchase_payments to authenticated;

revoke truncate, references, trigger on table public.financial_transactions
  from public, anon, authenticated, service_role;

-- This legacy helper is still used internally by the harmless purchase sync
-- trigger. Its latest definition only selects a payment transaction id because
-- finance_purchase_should_sync is permanently false; clients need no access.
revoke all on function public.sync_purchase_to_financial_transaction(uuid)
  from public, anon, authenticated, service_role;

select pg_catalog.pg_notify('pgrst', 'reload schema');
