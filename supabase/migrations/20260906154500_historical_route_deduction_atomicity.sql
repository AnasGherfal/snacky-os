-- Historical route deductions are deliberate, one-time inventory commands.
-- Bind each batch to one authenticated request and commit its batch, lines,
-- physical-stock checks, and immutable ledger rows in one transaction.

-- Never guess which legacy apply owns a source fingerprint. A duplicate,
-- blank, tampered, or actorless applied row needs an explicit operator review;
-- deleting or silently choosing one would destroy accounting evidence. This
-- preflight runs before any new objects are created, so a failure is clean.
do $historical_source_preflight$
begin
  if exists (
    select 1
    from public.historical_route_deduction_batches batch_row
    where batch_row.status = 'applied'
      and nullif(pg_catalog.btrim(batch_row.content_hash), '') is null
  ) then
    raise exception 'Historical deduction fingerprint migration blocked: an applied batch has a blank source hash. Review the applied history before retrying.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_batches batch_row
    where batch_row.status = 'applied'
      and pg_catalog.lower(pg_catalog.btrim(batch_row.content_hash)) is distinct from
        pg_catalog.encode(extensions.digest(batch_row.original_text, 'sha256'), 'hex')
  ) then
    raise exception 'Historical deduction fingerprint migration blocked: an applied batch source hash does not match its original text. Review the applied history before retrying.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_batches batch_row
    where batch_row.status = 'applied'
    group by pg_catalog.lower(pg_catalog.btrim(batch_row.content_hash))
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'Historical deduction fingerprint migration blocked: multiple applied batches claim the same source content. Review the duplicate history before retrying.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_batches batch_row
    left join public.team_members actor_row on actor_row.id = batch_row.applied_by
    where batch_row.status = 'applied'
      and (
        batch_row.applied_by is null
        or batch_row.applied_at is null
        or actor_row.auth_user_id is null
      )
  ) then
    raise exception 'Historical deduction fingerprint migration blocked: an applied batch has no complete actor identity. Review the applied history before retrying.'
      using errcode = '23514';
  end if;
end;
$historical_source_preflight$;

alter table public.historical_route_deduction_batches
  drop constraint if exists historical_route_deduction_batches_applied_source_hash_check;
alter table public.historical_route_deduction_batches
  add constraint historical_route_deduction_batches_applied_source_hash_check
  check (
    status <> 'applied'
    or content_hash ~ '^[0-9a-f]{64}$'
  );

create unique index if not exists idx_historical_route_deduction_batches_applied_source_once
  on public.historical_route_deduction_batches (
    pg_catalog.lower(pg_catalog.btrim(content_hash))
  )
  where status = 'applied';

create table if not exists public.historical_route_deduction_apply_operations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.historical_route_deduction_batches(id) on delete restrict,
  client_submission_id text not null,
  request_payload jsonb not null,
  result_payload jsonb,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint historical_route_deduction_apply_operations_batch_key unique (batch_id),
  constraint historical_route_deduction_apply_operations_submission_key unique (client_submission_id),
  constraint historical_route_deduction_apply_operations_submission_nonempty
    check (nullif(btrim(client_submission_id), '') is not null and length(client_submission_id) <= 200),
  constraint historical_route_deduction_apply_operations_request_object
    check (jsonb_typeof(request_payload) = 'object'),
  constraint historical_route_deduction_apply_operations_result_object
    check (result_payload is null or jsonb_typeof(result_payload) = 'object'),
  constraint historical_route_deduction_apply_operations_completion_check
    check (
      (result_payload is null and completed_at is null)
      or (result_payload is not null and completed_at is not null)
    )
);

create index if not exists idx_historical_route_deduction_apply_operations_created
  on public.historical_route_deduction_apply_operations(created_at desc);

alter table public.historical_route_deduction_apply_operations enable row level security;
revoke all on table public.historical_route_deduction_apply_operations
  from public, anon, authenticated;
grant all on table public.historical_route_deduction_apply_operations to service_role;

-- The source claim is the cross-batch exactly-once boundary. It is inserted
-- before any stock lock/write and commits only if the batch, lines, ledger and
-- operation receipt all commit. Legacy applied rows are backfilled only after
-- the fail-closed preflight above proves their hash and actor are unambiguous.
create table public.historical_route_deduction_source_claims (
  source_content_hash text primary key,
  batch_id uuid not null unique
    references public.historical_route_deduction_batches(id) on delete restrict,
  operation_id uuid unique
    references public.historical_route_deduction_apply_operations(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  claim_origin text not null,
  claimed_at timestamptz not null default pg_catalog.now(),
  constraint historical_route_deduction_source_claims_hash_check
    check (source_content_hash ~ '^[0-9a-f]{64}$'),
  constraint historical_route_deduction_source_claims_origin_check
    check (
      (claim_origin = 'atomic_apply' and operation_id is not null)
      or (claim_origin = 'legacy_backfill' and operation_id is null)
    )
);

insert into public.historical_route_deduction_source_claims (
  source_content_hash,
  batch_id,
  operation_id,
  actor_user_id,
  actor_team_member_id,
  claim_origin,
  claimed_at
)
select
  pg_catalog.lower(pg_catalog.btrim(batch_row.content_hash)),
  batch_row.id,
  null,
  actor_row.auth_user_id,
  batch_row.applied_by,
  'legacy_backfill',
  batch_row.applied_at
from public.historical_route_deduction_batches batch_row
join public.team_members actor_row on actor_row.id = batch_row.applied_by
where batch_row.status = 'applied';

alter table public.historical_route_deduction_source_claims enable row level security;
revoke all on table public.historical_route_deduction_source_claims
  from public, anon, authenticated;
grant all on table public.historical_route_deduction_source_claims to service_role;

-- Operation receipts are append-once records. A pending receipt may be
-- inserted, but only the canonical SECURITY DEFINER apply function may make
-- the single pending -> completed transition. Even service_role cannot edit a
-- completed receipt or delete/truncate receipt history.
create or replace function public.snacky_guard_historical_deduction_apply_operation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_apply_function_owner text;
  v_completion_operation_id text;
begin
  if tg_op = 'INSERT' then
    if new.result_payload is not null or new.completed_at is not null then
      raise exception 'Historical deduction operation receipts must be inserted pending.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Historical deduction operation receipts cannot be deleted.'
      using errcode = '42501';
  end if;

  if old.result_payload is not null or old.completed_at is not null then
    raise exception 'Completed historical deduction operation receipts are immutable.'
      using errcode = '42501';
  end if;

  if new.result_payload is null or new.completed_at is null then
    raise exception 'A historical deduction operation receipt can only transition directly from pending to completed.'
      using errcode = '23514';
  end if;

  if new.id is distinct from old.id
    or new.batch_id is distinct from old.batch_id
    or new.client_submission_id is distinct from old.client_submission_id
    or new.request_payload is distinct from old.request_payload
    or new.actor_user_id is distinct from old.actor_user_id
    or new.actor_team_member_id is distinct from old.actor_team_member_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Historical deduction operation receipt identity and request fields are immutable.'
      using errcode = '42501';
  end if;

  select pg_catalog.pg_get_userbyid(procedure_row.proowner)::text
  into v_apply_function_owner
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid = pg_catalog.to_regprocedure(
    'public.apply_historical_route_deduction_batch(uuid,text)'
  );

  v_completion_operation_id := pg_catalog.current_setting(
    'snacky.historical_route_deduction_apply_operation_id',
    true
  );

  if v_apply_function_owner is null
    or current_user::text is distinct from v_apply_function_owner
    or v_completion_operation_id is distinct from old.id::text
  then
    raise exception 'Only the canonical historical deduction apply function can complete an operation receipt.'
      using errcode = '42501';
  end if;

  if new.result_payload ->> 'operation_id' is distinct from old.id::text
    or new.result_payload ->> 'client_submission_id' is distinct from old.client_submission_id
  then
    raise exception 'Historical deduction operation result is not bound to its immutable receipt.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.historical_route_deduction_source_claims claim_row
    where claim_row.operation_id = old.id
      and claim_row.batch_id = old.batch_id
      and claim_row.actor_user_id = old.actor_user_id
      and claim_row.actor_team_member_id = old.actor_team_member_id
      and claim_row.source_content_hash = old.request_payload ->> 'content_hash'
      and claim_row.source_content_hash = new.result_payload ->> 'content_hash'
      and claim_row.claim_origin = 'atomic_apply'
  ) then
    raise exception 'Historical deduction operation completion has no matching immutable source claim.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create or replace function public.snacky_reject_historical_deduction_operation_truncate()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Historical deduction operation receipts cannot be truncated.'
    using errcode = '42501';
  return null;
end;
$function$;

create or replace function public.snacky_guard_historical_deduction_source_claim()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_apply_function_owner text;
  v_completion_operation_id text;
  v_operation public.historical_route_deduction_apply_operations%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Historical deduction source claims are immutable.'
      using errcode = '42501';
  end if;

  if new.claim_origin <> 'atomic_apply' or new.operation_id is null then
    raise exception 'New historical deduction source claims must come from the canonical atomic apply command.'
      using errcode = '42501';
  end if;

  select pg_catalog.pg_get_userbyid(procedure_row.proowner)::text
  into v_apply_function_owner
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid = pg_catalog.to_regprocedure(
    'public.apply_historical_route_deduction_batch(uuid,text)'
  );

  v_completion_operation_id := pg_catalog.current_setting(
    'snacky.historical_route_deduction_apply_operation_id',
    true
  );

  if v_apply_function_owner is null
    or current_user::text is distinct from v_apply_function_owner
    or v_completion_operation_id is distinct from new.operation_id::text
  then
    raise exception 'Only the canonical historical deduction apply function can create a source claim.'
      using errcode = '42501';
  end if;

  select operation_row.*
  into v_operation
  from public.historical_route_deduction_apply_operations operation_row
  where operation_row.id = new.operation_id
  for update;

  if not found
    or v_operation.batch_id is distinct from new.batch_id
    or v_operation.actor_user_id is distinct from new.actor_user_id
    or v_operation.actor_team_member_id is distinct from new.actor_team_member_id
    or v_operation.request_payload ->> 'content_hash' is distinct from new.source_content_hash
    or v_operation.result_payload is not null
    or v_operation.completed_at is not null
  then
    raise exception 'Historical deduction source claim does not match its pending immutable operation.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create or replace function public.snacky_reject_historical_deduction_source_claim_truncate()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Historical deduction source claims cannot be truncated.'
    using errcode = '42501';
  return null;
end;
$function$;

create or replace function public.snacky_guard_historical_deduction_applied_batch()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_apply_function_owner text;
  v_completion_operation_id text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'applied' then
      raise exception 'Historical deduction batches cannot be inserted as applied.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'applied' then
      raise exception 'Applied historical deduction batches cannot be deleted.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.status = 'applied' and (
    new.status is distinct from old.status
    or new.original_text is distinct from old.original_text
    or new.content_hash is distinct from old.content_hash
    or new.row_count is distinct from old.row_count
    or new.ready_row_count is distinct from old.ready_row_count
    or new.needs_review_count is distinct from old.needs_review_count
    or new.total_quantity is distinct from old.total_quantity
    or new.created_by is distinct from old.created_by
    or new.previewed_at is distinct from old.previewed_at
    or new.applied_by is distinct from old.applied_by
    or new.applied_at is distinct from old.applied_at
  ) then
    raise exception 'Applied historical deduction source, totals, status, and actor are immutable.'
      using errcode = '42501';
  end if;

  if old.status <> 'applied' and new.status = 'applied' then
    select pg_catalog.pg_get_userbyid(procedure_row.proowner)::text
    into v_apply_function_owner
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = pg_catalog.to_regprocedure(
      'public.apply_historical_route_deduction_batch(uuid,text)'
    );

    v_completion_operation_id := pg_catalog.current_setting(
      'snacky.historical_route_deduction_apply_operation_id',
      true
    );

    if v_apply_function_owner is null
      or current_user::text is distinct from v_apply_function_owner
      or v_completion_operation_id is null
      or not exists (
        select 1
        from public.historical_route_deduction_source_claims claim_row
        join public.historical_route_deduction_apply_operations operation_row
          on operation_row.id = claim_row.operation_id
        where claim_row.batch_id = new.id
          and claim_row.source_content_hash = new.content_hash
          and claim_row.actor_team_member_id = new.applied_by
          and claim_row.actor_user_id = operation_row.actor_user_id
          and claim_row.claim_origin = 'atomic_apply'
          and operation_row.id::text = v_completion_operation_id
          and operation_row.batch_id = new.id
          and operation_row.actor_team_member_id = new.applied_by
          and operation_row.result_payload is null
          and operation_row.completed_at is null
      )
    then
      raise exception 'An applied historical deduction requires its locked actor-bound source claim.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_hist_deduction_apply_operation_immutable_row
  on public.historical_route_deduction_apply_operations;
create trigger trg_hist_deduction_apply_operation_immutable_row
before insert or update or delete
on public.historical_route_deduction_apply_operations
for each row
execute function public.snacky_guard_historical_deduction_apply_operation();
alter table public.historical_route_deduction_apply_operations
  enable always trigger trg_hist_deduction_apply_operation_immutable_row;

drop trigger if exists trg_hist_deduction_apply_operation_no_truncate
  on public.historical_route_deduction_apply_operations;
create trigger trg_hist_deduction_apply_operation_no_truncate
before truncate
on public.historical_route_deduction_apply_operations
for each statement
execute function public.snacky_reject_historical_deduction_operation_truncate();
alter table public.historical_route_deduction_apply_operations
  enable always trigger trg_hist_deduction_apply_operation_no_truncate;

create trigger trg_hist_deduction_source_claim_immutable_row
before insert or update or delete
on public.historical_route_deduction_source_claims
for each row
execute function public.snacky_guard_historical_deduction_source_claim();
alter table public.historical_route_deduction_source_claims
  enable always trigger trg_hist_deduction_source_claim_immutable_row;

create trigger trg_hist_deduction_source_claim_no_truncate
before truncate
on public.historical_route_deduction_source_claims
for each statement
execute function public.snacky_reject_historical_deduction_source_claim_truncate();
alter table public.historical_route_deduction_source_claims
  enable always trigger trg_hist_deduction_source_claim_no_truncate;

drop trigger if exists trg_hist_deduction_applied_batch_immutable
  on public.historical_route_deduction_batches;
create trigger trg_hist_deduction_applied_batch_immutable
before insert or update or delete
on public.historical_route_deduction_batches
for each row
execute function public.snacky_guard_historical_deduction_applied_batch();
alter table public.historical_route_deduction_batches
  enable always trigger trg_hist_deduction_applied_batch_immutable;

revoke all on function public.snacky_guard_historical_deduction_apply_operation()
  from public, anon, authenticated, service_role;
revoke all on function public.snacky_reject_historical_deduction_operation_truncate()
  from public, anon, authenticated, service_role;
revoke all on function public.snacky_guard_historical_deduction_source_claim()
  from public, anon, authenticated, service_role;
revoke all on function public.snacky_reject_historical_deduction_source_claim_truncate()
  from public, anon, authenticated, service_role;
revoke all on function public.snacky_guard_historical_deduction_applied_batch()
  from public, anon, authenticated, service_role;

-- The old function was invoker-scoped, executable by PUBLIC, and trusted a
-- caller-provided actor UUID. Remove that signature before exposing the
-- authenticated contract so PostgREST cannot choose an unsafe overload.
revoke all on function public.apply_historical_route_deduction_batch(uuid, uuid)
  from public, anon, authenticated, service_role;
drop function if exists public.apply_historical_route_deduction_batch(uuid, uuid);

create or replace function public.apply_historical_route_deduction_batch(
  target_batch_id uuid,
  p_client_submission_id text
)
returns table (
  inserted_movements integer,
  skipped_review_rows integer,
  already_applied boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_batch public.historical_route_deduction_batches%rowtype;
  v_operation public.historical_route_deduction_apply_operations%rowtype;
  v_source_claim public.historical_route_deduction_source_claims%rowtype;
  v_line public.historical_route_deduction_lines%rowtype;
  v_line_lock record;
  v_stock record;
  v_product_lock record;
  v_movement_lock record;
  v_lines_payload jsonb := '[]'::jsonb;
  v_source_content_hash text;
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_movement_ids jsonb := '[]'::jsonb;
  v_line_payload jsonb;
  v_movement_id uuid;
  v_ready_count integer := 0;
  v_review_count integer := 0;
  v_applied_count integer := 0;
  v_invalid_count integer := 0;
  v_existing_count integer := 0;
  v_locked_product_count integer := 0;
  v_updated_count integer := 0;
  v_on_hand bigint := 0;
  v_reserved bigint := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to apply a historical route deduction.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only an owner or admin can apply a historical route deduction.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if target_batch_id is null then
    raise exception 'Historical route deduction batch is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:historical-route-deduction:' || target_batch_id::text, 0)
  );

  select batch_row.*
  into v_batch
  from public.historical_route_deduction_batches batch_row
  where batch_row.id = target_batch_id
  for update;

  if not found then
    raise exception 'Historical route deduction batch was not found.' using errcode = '23503';
  end if;

  v_source_content_hash := pg_catalog.encode(
    extensions.digest(v_batch.original_text, 'sha256'),
    'hex'
  );
  if v_batch.content_hash is distinct from v_source_content_hash then
    raise exception 'Historical deduction source hash does not match its original text. Refresh and review the preview; no inventory was changed.'
      using errcode = '23514';
  end if;

  -- Lock the complete batch line set before hashing the immutable command.
  -- Ready becomes applied on success, so status is deliberately excluded from
  -- this payload and both states select the same business rows on a retry.
  for v_line_lock in
    select line_row.id
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
    order by line_row.id
    for update
  loop
    null;
  end loop;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'line_id', line_row.id,
        'line_number', line_row.line_number,
        'product_id', line_row.product_id,
        'quantity', line_row.quantity,
        'storage_location_id', line_row.storage_location_id,
        'machine_id', line_row.machine_id,
        'section_name', line_row.section_name,
        'machine_alias', line_row.machine_alias,
        'original_text', line_row.original_text
      )
      order by line_row.storage_location_id, line_row.product_id, line_row.line_number, line_row.id
    ),
    '[]'::jsonb
  )
  into v_lines_payload
  from public.historical_route_deduction_lines line_row
  where line_row.import_batch_id = target_batch_id
    and line_row.status in ('ready', 'applied');

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'batch_id', target_batch_id,
    'content_hash', v_source_content_hash,
    'row_count', v_batch.row_count,
    'ready_row_count', v_batch.ready_row_count,
    'needs_review_count', v_batch.needs_review_count,
    'total_quantity', v_batch.total_quantity,
    'lines', v_lines_payload
  );

  -- Different batch IDs containing the same pasted source serialize here.
  -- The immutable unique claim is acquired before storage/product locks, so a
  -- serial or concurrent duplicate exits without any inventory side effect.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:historical-route-deduction-source:' || v_source_content_hash,
      0
    )
  );

  -- Exact replay is evaluated before rejecting the now-applied parent state.
  select operation_row.*
  into v_operation
  from public.historical_route_deduction_apply_operations operation_row
  where operation_row.batch_id = target_batch_id
  for update;

  if found then
    if v_operation.client_submission_id is distinct from v_submission_id
      or v_operation.request_payload is distinct from v_request_payload
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.result_payload is null
      or v_operation.completed_at is null
      or v_batch.status <> 'applied'
      or v_batch.applied_by is distinct from v_operation.actor_team_member_id
      or v_batch.applied_at is null
    then
      raise exception 'Historical deduction replay does not match the committed immutable result. Stop and review the batch.'
        using errcode = '23505';
    end if;

    select claim_row.*
    into v_source_claim
    from public.historical_route_deduction_source_claims claim_row
    where claim_row.source_content_hash = v_source_content_hash
    for update;

    if not found
      or v_source_claim.batch_id is distinct from target_batch_id
      or v_source_claim.operation_id is distinct from v_operation.id
      or v_source_claim.actor_user_id is distinct from v_operation.actor_user_id
      or v_source_claim.actor_team_member_id is distinct from v_operation.actor_team_member_id
      or v_source_claim.claim_origin <> 'atomic_apply'
    then
      raise exception 'Historical deduction replay has no matching immutable source claim. Stop and review the batch.'
        using errcode = '23505';
    end if;

    -- Follow the package lock hierarchy even on replay: batch/lines, then all
    -- storage pairs sorted storage then product, products, and movement rows.
    for v_stock in
      select distinct line_row.storage_location_id, line_row.product_id
      from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = target_batch_id
        and line_row.status = 'applied'
      order by line_row.storage_location_id, line_row.product_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(v_stock.product_id::text),
        pg_catalog.hashtext(v_stock.storage_location_id::text)
      );
    end loop;

    for v_product_lock in
      select product_row.id
      from public.products product_row
      where product_row.id in (
        select distinct line_row.product_id
        from public.historical_route_deduction_lines line_row
        where line_row.import_batch_id = target_batch_id
          and line_row.status = 'applied'
      )
      order by product_row.id
      for update
    loop
      null;
    end loop;

    for v_movement_lock in
      select movement.id
      from public.inventory_movements movement
      where movement.historical_route_deduction_line_id in (
        select line_row.id
        from public.historical_route_deduction_lines line_row
        where line_row.import_batch_id = target_batch_id
      )
        or movement.idempotency_key in (
          select 'historical-route-deduction:v2:' || line_row.id::text
          from public.historical_route_deduction_lines line_row
          where line_row.import_batch_id = target_batch_id
        )
      order by movement.id
      for update
    loop
      null;
    end loop;

    select
      pg_catalog.count(*)::integer,
      pg_catalog.count(*) filter (
        where movement.id is null
          or movement.id is distinct from line_row.movement_id
          or movement.product_id is distinct from line_row.product_id
          or movement.quantity is distinct from line_row.quantity
          or movement.from_entity_type::text <> 'storage'
          or movement.from_entity_id is distinct from line_row.storage_location_id
          or movement.to_entity_type::text <> 'historical_route'
          or movement.to_entity_id is not null
          or movement.reason::text <> 'historical_route_deduction'
          or movement.related_route_id is not null
          or movement.related_route_stop_id is not null
          or movement.related_purchase_id is not null
          or movement.related_purchase_line_id is not null
          or movement.related_machine_id is distinct from line_row.machine_id
          or movement.related_refill_order_id is not null
          or movement.related_pickup_batch_id is not null
          or movement.import_batch_id is distinct from target_batch_id
          or movement.unit_cost_lyd is not null
          or movement.line_total_lyd is not null
          or movement.original_text is distinct from line_row.original_text
          or movement.historical_route_deduction_line_id is distinct from line_row.id
          or movement.reversed_movement_id is not null
          or movement.correction_reason is not null
          or movement.source_type is distinct from 'historical_route_deduction'
          or movement.source_id is distinct from line_row.id
          or movement.idempotency_key is distinct from 'historical-route-deduction:v2:' || line_row.id::text
          or movement.idempotency_payload is distinct from pg_catalog.jsonb_build_object(
            'contract_version', 2,
            'operation_id', v_operation.id,
            'client_submission_id', v_operation.client_submission_id,
            'batch_id', target_batch_id,
            'content_hash', v_source_content_hash,
            'line_id', line_row.id,
            'product_id', line_row.product_id,
            'quantity', line_row.quantity,
            'storage_location_id', line_row.storage_location_id,
            'machine_id', line_row.machine_id,
            'original_text', line_row.original_text
          )
          or movement.created_by is distinct from v_operation.actor_team_member_id
          or movement.notes is distinct from pg_catalog.concat_ws(
            ' - ',
            'Old route data was not previously deducted from storage',
            pg_catalog.concat('Machine/location: ', coalesce(line_row.section_name, line_row.machine_alias, 'Unknown')),
            pg_catalog.concat('Original row: ', line_row.original_text)
          )
      )::integer
    into v_applied_count, v_invalid_count
    from public.historical_route_deduction_lines line_row
    left join public.inventory_movements movement on movement.id = line_row.movement_id
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'applied';

    select pg_catalog.count(*)::integer
    into v_existing_count
    from public.inventory_movements movement
    where movement.import_batch_id = target_batch_id
      and movement.reason::text = 'historical_route_deduction';

    select pg_catalog.count(*)::integer
    into v_review_count
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'needs_review';

    select coalesce(pg_catalog.jsonb_agg(line_row.movement_id order by line_row.id), '[]'::jsonb)
    into v_movement_ids
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'applied';

    v_result_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'operation_id', v_operation.id,
      'client_submission_id', v_operation.client_submission_id,
      'batch_id', target_batch_id,
      'content_hash', v_source_content_hash,
      'inserted_movements', v_applied_count,
      'skipped_review_rows', v_review_count,
      'movement_ids', v_movement_ids
    );

    if v_applied_count = 0
      or v_invalid_count <> 0
      or v_existing_count <> v_applied_count
      or v_operation.result_payload is distinct from v_result_payload
    then
      raise exception 'Historical deduction ledger no longer matches its committed result. Stop and review the batch.'
        using errcode = '23514';
    end if;

    return query select v_applied_count, v_review_count, true;
    return;
  end if;

  select claim_row.*
  into v_source_claim
  from public.historical_route_deduction_source_claims claim_row
  where claim_row.source_content_hash = v_source_content_hash
  for update;

  if found then
    raise exception 'This historical deduction source content was already claimed by batch %. Nothing was changed.',
      v_source_claim.batch_id
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_batches applied_batch
    where applied_batch.status = 'applied'
      and pg_catalog.lower(pg_catalog.btrim(applied_batch.content_hash)) = v_source_content_hash
      and applied_batch.id is distinct from target_batch_id
  ) then
    raise exception 'This historical deduction source content already exists in applied history without a usable claim. Stop and review it; nothing was changed.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_apply_operations operation_row
    where operation_row.client_submission_id = v_submission_id
      and operation_row.batch_id is distinct from target_batch_id
  ) then
    raise exception 'This historical deduction submission id was already used for another batch.' using errcode = '23505';
  end if;

  if v_batch.status = 'applied' then
    raise exception 'This applied historical deduction has no exact operation receipt. Stop and review it; no inventory was changed.'
      using errcode = '23514';
  end if;
  if v_batch.status <> 'previewed' then
    raise exception 'Only a previewed historical route deduction batch can be applied.' using errcode = '23514';
  end if;

  select
    pg_catalog.count(*) filter (where line_row.status = 'ready')::integer,
    pg_catalog.count(*) filter (where line_row.status = 'needs_review')::integer,
    pg_catalog.count(*) filter (
      where line_row.status = 'ready'
        and (
          line_row.product_id is null
          or line_row.machine_id is null
          or line_row.quantity is null
          or line_row.quantity <= 0
          or line_row.storage_location_id is null
        )
    )::integer
  into v_ready_count, v_review_count, v_invalid_count
  from public.historical_route_deduction_lines line_row
  where line_row.import_batch_id = target_batch_id;

  if v_ready_count = 0 then
    raise exception 'This batch has no ready deduction rows to apply.' using errcode = '23514';
  end if;
  if v_invalid_count <> 0
    or v_batch.ready_row_count is distinct from v_ready_count
    or v_batch.needs_review_count is distinct from v_review_count
    or v_batch.row_count is distinct from v_ready_count + v_review_count
    or v_batch.total_quantity is distinct from (
      select coalesce(pg_catalog.sum(line_row.quantity), 0)::integer
      from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = target_batch_id
        and line_row.status = 'ready'
    )
  then
    raise exception 'Historical deduction preview totals or ready rows are inconsistent. Refresh the preview before applying.'
      using errcode = '23514';
  end if;

  insert into public.historical_route_deduction_apply_operations (
    batch_id,
    client_submission_id,
    request_payload,
    actor_user_id,
    actor_team_member_id
  ) values (
    target_batch_id,
    v_submission_id,
    v_request_payload,
    v_actor_user_id,
    v_actor_team_member_id
  )
  returning * into v_operation;

  perform pg_catalog.set_config(
    'snacky.historical_route_deduction_apply_operation_id',
    v_operation.id::text,
    true
  );

  insert into public.historical_route_deduction_source_claims (
    source_content_hash,
    batch_id,
    operation_id,
    actor_user_id,
    actor_team_member_id,
    claim_origin
  ) values (
    v_source_content_hash,
    target_batch_id,
    v_operation.id,
    v_actor_user_id,
    v_actor_team_member_id,
    'atomic_apply'
  )
  returning * into v_source_claim;

  -- All storage balance locks are taken in storage/product order before any
  -- product or movement row lock, matching route pickup and purchase writers.
  for v_stock in
    select
      line_row.storage_location_id,
      line_row.product_id,
      pg_catalog.sum(line_row.quantity::bigint)::bigint as quantity
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
    group by line_row.storage_location_id, line_row.product_id
    order by line_row.storage_location_id, line_row.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_stock.product_id::text),
      pg_catalog.hashtext(v_stock.storage_location_id::text)
    );
  end loop;

  for v_product_lock in
    select product_row.id, product_row.active
    from public.products product_row
    where product_row.id in (
      select distinct line_row.product_id
      from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = target_batch_id
        and line_row.status = 'ready'
    )
    order by product_row.id
    for update
  loop
    v_locked_product_count := v_locked_product_count + 1;
    if not coalesce(v_product_lock.active, false) then
      raise exception 'Historical deduction product % is inactive. Refresh the preview before applying.', v_product_lock.id
        using errcode = '23514';
    end if;
  end loop;

  if v_locked_product_count <> (
    select pg_catalog.count(distinct line_row.product_id)::integer
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
  ) then
    raise exception 'A historical deduction product no longer exists. Refresh the preview before applying.' using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.historical_route_deduction_lines line_row
    left join public.storage_locations storage_row on storage_row.id = line_row.storage_location_id
    left join public.machines machine_row on machine_row.id = line_row.machine_id
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
      and (
        storage_row.id is null
        or not coalesce(storage_row.active, false)
        or machine_row.id is null
      )
  ) then
    raise exception 'A historical deduction storage or machine is missing/inactive. Refresh the preview before applying.'
      using errcode = '23514';
  end if;

  -- Lock any stale/crafted row that could collide with the canonical line or
  -- operation key, then reject it rather than guessing or manufacturing links.
  for v_movement_lock in
    select movement.id
    from public.inventory_movements movement
    where movement.historical_route_deduction_line_id in (
      select line_row.id
      from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = target_batch_id
    )
      or movement.idempotency_key in (
        select 'historical-route-deduction:v2:' || line_row.id::text
        from public.historical_route_deduction_lines line_row
        where line_row.import_batch_id = target_batch_id
      )
    order by movement.id
    for update
  loop
    null;
  end loop;

  select pg_catalog.count(*)::integer
  into v_existing_count
  from public.inventory_movements movement
  where movement.historical_route_deduction_line_id in (
    select line_row.id
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
  )
    or movement.idempotency_key in (
      select 'historical-route-deduction:v2:' || line_row.id::text
      from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = target_batch_id
    )
    or (
      movement.import_batch_id = target_batch_id
      and movement.reason::text = 'historical_route_deduction'
    );

  if v_existing_count <> 0 then
    raise exception 'Historical deduction already has unreceipted ledger rows. Stop and review the batch; no new inventory was changed.'
      using errcode = '23514';
  end if;

  for v_stock in
    select
      line_row.storage_location_id,
      line_row.product_id,
      pg_catalog.sum(line_row.quantity::bigint)::bigint as quantity
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
    group by line_row.storage_location_id, line_row.product_id
    order by line_row.storage_location_id, line_row.product_id
  loop
    select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
    into v_on_hand
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = v_stock.storage_location_id
      and inventory.product_id = v_stock.product_id;

    if v_on_hand < v_stock.quantity then
      raise exception 'Historical deduction needs % unit(s) of product % in storage, but only % are physically on hand. Nothing was changed.',
        v_stock.quantity,
        v_stock.product_id,
        greatest(v_on_hand, 0::bigint)
        using errcode = '23514';
    end if;

    select coalesce(pg_catalog.sum(
      greatest(coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0), 0)::bigint
    ), 0::bigint)
    into v_reserved
    from public.route_stock_lines stock_line
    join public.routes route_row on route_row.id = stock_line.route_id
    where stock_line.product_id = v_stock.product_id
      and route_row.status::text in (
        'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
        'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
      );

    if v_on_hand - v_reserved < v_stock.quantity then
      raise exception 'Historical deduction needs % available unit(s) of product %, but only % remain after active route reservations. Nothing was changed.',
        v_stock.quantity,
        v_stock.product_id,
        greatest(v_on_hand - v_reserved, 0::bigint)
        using errcode = '23514';
    end if;
  end loop;

  for v_line in
    select line_row.*
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
    order by line_row.storage_location_id, line_row.product_id, line_row.line_number, line_row.id
  loop
    v_line_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'operation_id', v_operation.id,
      'client_submission_id', v_operation.client_submission_id,
      'batch_id', target_batch_id,
      'content_hash', v_source_content_hash,
      'line_id', v_line.id,
      'product_id', v_line.product_id,
      'quantity', v_line.quantity,
      'storage_location_id', v_line.storage_location_id,
      'machine_id', v_line.machine_id,
      'original_text', v_line.original_text
    );

    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_machine_id,
      created_by,
      notes,
      import_batch_id,
      original_text,
      historical_route_deduction_line_id,
      source_type,
      source_id,
      idempotency_key,
      idempotency_payload
    ) values (
      v_line.product_id,
      v_line.quantity,
      'storage'::public.inventory_entity_type,
      v_line.storage_location_id,
      'historical_route'::public.inventory_entity_type,
      null,
      'historical_route_deduction'::public.movement_reason,
      v_line.machine_id,
      v_actor_team_member_id,
      pg_catalog.concat_ws(
        ' - ',
        'Old route data was not previously deducted from storage',
        pg_catalog.concat('Machine/location: ', coalesce(v_line.section_name, v_line.machine_alias, 'Unknown')),
        pg_catalog.concat('Original row: ', v_line.original_text)
      ),
      target_batch_id,
      v_line.original_text,
      v_line.id,
      'historical_route_deduction',
      v_line.id,
      'historical-route-deduction:v2:' || v_line.id::text,
      v_line_payload
    )
    returning id into v_movement_id;

    update public.historical_route_deduction_lines line_row
    set status = 'applied',
        movement_id = v_movement_id,
        applied_at = pg_catalog.now()
    where line_row.id = v_line.id
      and line_row.import_batch_id = target_batch_id
      and line_row.status = 'ready'
      and line_row.movement_id is null;

    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'Historical deduction line % changed while applying. Nothing was changed.', v_line.id
        using errcode = '40001';
    end if;

    v_applied_count := v_applied_count + 1;
  end loop;

  select coalesce(pg_catalog.jsonb_agg(line_row.movement_id order by line_row.id), '[]'::jsonb)
  into v_movement_ids
  from public.historical_route_deduction_lines line_row
  where line_row.import_batch_id = target_batch_id
    and line_row.status = 'applied';

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'operation_id', v_operation.id,
    'client_submission_id', v_operation.client_submission_id,
    'batch_id', target_batch_id,
    'content_hash', v_source_content_hash,
    'inserted_movements', v_applied_count,
    'skipped_review_rows', v_review_count,
    'movement_ids', v_movement_ids
  );

  update public.historical_route_deduction_batches batch_row
  set status = 'applied',
      applied_by = v_actor_team_member_id,
      applied_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where batch_row.id = target_batch_id
    and batch_row.status = 'previewed';

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Historical deduction batch changed while applying. Nothing was changed.' using errcode = '40001';
  end if;

  perform pg_catalog.set_config(
    'snacky.historical_route_deduction_apply_operation_id',
    v_operation.id::text,
    true
  );

  update public.historical_route_deduction_apply_operations operation_row
  set result_payload = v_result_payload,
      completed_at = pg_catalog.now()
  where operation_row.id = v_operation.id
    and operation_row.result_payload is null
    and operation_row.completed_at is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Historical deduction operation receipt could not be completed. Nothing was changed.' using errcode = '40001';
  end if;

  perform pg_catalog.set_config(
    'snacky.historical_route_deduction_apply_operation_id',
    '',
    true
  );

  return query select v_applied_count, v_review_count, false;
end;
$function$;

revoke all on function public.apply_historical_route_deduction_batch(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_historical_route_deduction_batch(uuid, text)
  to authenticated;

-- Inventory history stays readable, but this recovery workflow no longer
-- depends on raw authenticated INSERT. The protected function owns the write.
revoke all on table public.inventory_movements from public, anon, authenticated;
grant select on table public.inventory_movements to authenticated;
grant all on table public.inventory_movements to service_role;

select pg_catalog.pg_notify('pgrst', 'reload schema');
