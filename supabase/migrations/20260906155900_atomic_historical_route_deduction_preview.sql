-- Previewing a historical route deduction is one database command. The old
-- app flow inserted the batch first and its lines in a second request, which
-- could leave a convincing but empty/partial batch after a timeout or error.

create table if not exists public.historical_route_deduction_preview_operations (
  client_submission_id text primary key,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null
    check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  batch_id uuid not null unique
    references public.historical_route_deduction_batches(id) on delete restrict,
  result_payload jsonb not null
    check (pg_catalog.jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default pg_catalog.clock_timestamp(),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint historical_route_deduction_preview_submission_id_check
    check (
      pg_catalog.length(pg_catalog.btrim(client_submission_id)) between 1 and 200
      and client_submission_id = pg_catalog.btrim(client_submission_id)
    )
);

alter table public.historical_route_deduction_preview_operations
  enable row level security;
revoke all on table public.historical_route_deduction_preview_operations
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_historical_deduction_preview_operation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Completed historical deduction preview receipts are immutable.'
    using errcode = '42501';
end;
$function$;

create or replace function public.snacky_reject_historical_deduction_preview_truncate()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Historical deduction preview receipts cannot be truncated.'
    using errcode = '42501';
  return null;
end;
$function$;

revoke all on function public.snacky_guard_historical_deduction_preview_operation()
  from public, anon, authenticated, service_role;
revoke all on function public.snacky_reject_historical_deduction_preview_truncate()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_hist_deduction_preview_operation_immutable
  on public.historical_route_deduction_preview_operations;
create trigger trg_hist_deduction_preview_operation_immutable
before update or delete
on public.historical_route_deduction_preview_operations
for each row
execute function public.snacky_guard_historical_deduction_preview_operation();
alter table public.historical_route_deduction_preview_operations
  enable always trigger trg_hist_deduction_preview_operation_immutable;

drop trigger if exists trg_hist_deduction_preview_operation_no_truncate
  on public.historical_route_deduction_preview_operations;
create trigger trg_hist_deduction_preview_operation_no_truncate
before truncate
on public.historical_route_deduction_preview_operations
for each statement
execute function public.snacky_reject_historical_deduction_preview_truncate();
alter table public.historical_route_deduction_preview_operations
  enable always trigger trg_hist_deduction_preview_operation_no_truncate;

create or replace function public.snacky_preview_historical_route_deduction_v1(
  p_client_submission_id text,
  p_original_text text,
  p_notes text,
  p_default_storage_location_id uuid,
  p_lines jsonb
)
returns table (
  batch_id uuid,
  row_count integer,
  ready_row_count integer,
  needs_review_count integer,
  total_quantity integer,
  already_previewed boolean
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
  v_original_text text := coalesce(p_original_text, '');
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_content_hash text;
  v_request_lines_payload jsonb := '[]'::jsonb;
  v_lines_payload jsonb := '[]'::jsonb;
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_persisted_lines_payload jsonb := '[]'::jsonb;
  v_persisted_request_lines_payload jsonb := '[]'::jsonb;
  v_batch_notes text;
  v_duplicate_applied_batch_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row_count integer := 0;
  v_ready_count integer := 0;
  v_review_count integer := 0;
  v_total_quantity bigint := 0;
  v_invalid_count integer := 0;
  v_distinct_line_count integer := 0;
  v_requested_product_count integer := 0;
  v_locked_product_count integer := 0;
  v_operation public.historical_route_deduction_preview_operations%rowtype;
  v_batch public.historical_route_deduction_batches%rowtype;
  v_product record;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to preview a historical route deduction.'
      using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only an owner or admin can preview a historical route deduction.'
      using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.'
      using errcode = '42501';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable preview submission id between 1 and 200 characters is required.'
      using errcode = '22023';
  end if;
  if nullif(pg_catalog.btrim(v_original_text), '') is null
    or pg_catalog.octet_length(v_original_text) > 1000000
  then
    raise exception 'Historical route text must be between 1 byte and 1 MB.'
      using errcode = '22023';
  end if;
  if v_notes is not null and pg_catalog.length(v_notes) > 5000 then
    raise exception 'Historical deduction notes cannot exceed 5,000 characters.'
      using errcode = '22023';
  end if;
  if p_default_storage_location_id is null then
    raise exception 'An active physical storage location is required.'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_lines, 'null'::jsonb)) is distinct from 'array' then
    raise exception 'Historical deduction preview lines must be a JSON array.'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_lines) < 1
    or pg_catalog.jsonb_array_length(p_lines) > 5000
  then
    raise exception 'Historical deduction preview must contain between 1 and 5,000 lines.'
      using errcode = '22023';
  end if;

  -- Canonicalize only the source interpretation supplied by the caller. Stock
  -- warning numbers are derived below from the database snapshot and are a
  -- result, not caller-controlled command input.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'line_number', input_row.line_number,
        'section_name', nullif(pg_catalog.btrim(coalesce(input_row.section_name, '')), ''),
        'machine_alias', nullif(pg_catalog.btrim(coalesce(input_row.machine_alias, '')), ''),
        'machine_id', input_row.machine_id,
        'product_alias', nullif(pg_catalog.btrim(coalesce(input_row.product_alias, '')), ''),
        'product_id', input_row.product_id,
        'quantity', input_row.quantity,
        'original_text', pg_catalog.btrim(coalesce(input_row.original_text, '')),
        'status', pg_catalog.lower(pg_catalog.btrim(coalesce(input_row.status, ''))),
        'review_reason', nullif(pg_catalog.btrim(coalesce(input_row.review_reason, '')), '')
      )
      order by input_row.line_number
    ),
    '[]'::jsonb
  )
  into v_request_lines_payload
  from pg_catalog.jsonb_to_recordset(p_lines) as input_row(
    line_number integer,
    section_name text,
    machine_alias text,
    machine_id uuid,
    product_alias text,
    product_id uuid,
    quantity integer,
    original_text text,
    status text,
    review_reason text
  );

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where line_row.status = 'ready')::integer,
    pg_catalog.count(*) filter (where line_row.status = 'needs_review')::integer,
    coalesce(pg_catalog.sum(line_row.quantity::bigint) filter (where line_row.status = 'ready'), 0)::bigint,
    pg_catalog.count(*) filter (
      where line_row.line_number is null
        or line_row.line_number <= 0
        or line_row.original_text = ''
        or line_row.status not in ('ready', 'needs_review')
        or (
          line_row.status = 'ready'
          and (
            line_row.machine_id is null
            or line_row.product_id is null
            or line_row.quantity is null
            or line_row.quantity <= 0
            or line_row.review_reason is not null
          )
        )
        or (
          line_row.status = 'needs_review'
          and line_row.review_reason is null
        )
    )::integer,
    pg_catalog.count(distinct line_row.line_number)::integer,
    pg_catalog.count(distinct line_row.product_id) filter (where line_row.status = 'ready')::integer
  into
    v_row_count,
    v_ready_count,
    v_review_count,
    v_total_quantity,
    v_invalid_count,
    v_distinct_line_count,
    v_requested_product_count
  from pg_catalog.jsonb_to_recordset(v_request_lines_payload) as line_row(
    line_number integer,
    original_text text,
    status text,
    review_reason text,
    machine_id uuid,
    product_id uuid,
    quantity integer
  );

  if v_invalid_count > 0
    or v_distinct_line_count <> v_row_count
    or v_ready_count + v_review_count <> v_row_count
  then
    raise exception 'Historical deduction preview contains invalid or duplicate lines.'
      using errcode = '22023';
  end if;
  if v_total_quantity > 2147483647 then
    raise exception 'Historical deduction preview quantity is too large.'
      using errcode = '22003';
  end if;

  v_content_hash := pg_catalog.encode(
    extensions.digest(v_original_text, 'sha256'),
    'hex'
  );
  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'original_text', v_original_text,
    'content_hash', v_content_hash,
    'notes', v_notes,
    'default_storage_location_id', p_default_storage_location_id,
    'lines', v_request_lines_payload
  );

  -- A command-scoped mutex makes the same retry serialize before any parent
  -- row is inserted.  Because this is one transaction, any line failure also
  -- removes the batch and receipt automatically.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:historical-route-deduction-preview:v1:' || v_submission_id,
      0
    )
  );

  select operation_row.*
  into v_operation
  from public.historical_route_deduction_preview_operations operation_row
  where operation_row.client_submission_id = v_submission_id
  for update;

  if found then
    if v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
    then
      raise exception 'This historical deduction preview submission id was already used for a different actor or payload.'
        using errcode = '23505';
    end if;

    select batch_row.*
    into v_batch
    from public.historical_route_deduction_batches batch_row
    where batch_row.id = v_operation.batch_id
    for share;

    if not found then
      raise exception 'The saved historical deduction preview batch is missing. It was not recreated.'
        using errcode = '23503';
    end if;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'line_number', line_row.line_number,
          'section_name', line_row.section_name,
          'machine_alias', line_row.machine_alias,
          'machine_id', line_row.machine_id,
          'product_alias', line_row.product_alias,
          'product_id', line_row.product_id,
          'quantity', line_row.quantity,
          'original_text', line_row.original_text,
          'status', case
            when line_row.status = 'applied' then 'ready'
            when line_row.status = 'skipped' then 'needs_review'
            else line_row.status
          end,
          'review_reason', line_row.review_reason,
          'storage_location_id', line_row.storage_location_id,
          'storage_qty_before', line_row.storage_qty_before,
          'storage_qty_after', line_row.storage_qty_after,
          'storage_negative_warning', line_row.storage_negative_warning
        )
        order by line_row.line_number
      ),
      '[]'::jsonb
    )
    into v_persisted_lines_payload
    from public.historical_route_deduction_lines line_row
    where line_row.import_batch_id = v_batch.id;

    select coalesce(
      pg_catalog.jsonb_agg(
        line_element.value
          - 'storage_location_id'
          - 'storage_qty_before'
          - 'storage_qty_after'
          - 'storage_negative_warning'
        order by (line_element.value ->> 'line_number')::integer
      ),
      '[]'::jsonb
    )
    into v_persisted_request_lines_payload
    from pg_catalog.jsonb_array_elements(v_persisted_lines_payload) line_element;

    v_result_payload := pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'client_submission_id', v_submission_id,
      'batch_id', v_batch.id,
      'row_count', v_batch.row_count,
      'ready_row_count', v_batch.ready_row_count,
      'needs_review_count', v_batch.needs_review_count,
      'total_quantity', v_batch.total_quantity,
      'batch_notes', v_batch.notes,
      'previewed_at', v_batch.previewed_at,
      'lines', v_persisted_lines_payload
    );

    if v_batch.original_text is distinct from v_original_text
      or v_batch.content_hash is distinct from v_content_hash
      or v_batch.created_by is distinct from v_actor_team_member_id
      or v_batch.row_count is distinct from v_row_count
      or v_batch.ready_row_count is distinct from v_ready_count
      or v_batch.needs_review_count is distinct from v_review_count
      or v_batch.total_quantity is distinct from v_total_quantity::integer
      or v_persisted_request_lines_payload is distinct from v_request_lines_payload
      or v_operation.result_payload is distinct from v_result_payload
    then
      raise exception 'The saved historical deduction preview no longer matches its immutable receipt. It was not recreated.'
        using errcode = '23514';
    end if;

    return query select
      v_batch.id,
      v_batch.row_count,
      v_batch.ready_row_count,
      v_batch.needs_review_count,
      v_batch.total_quantity,
      true;
    return;
  end if;

  perform 1
  from public.storage_locations storage_row
  where storage_row.id = p_default_storage_location_id
    and coalesce(storage_row.active, false)
    and storage_row.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  for share;
  if not found then
    raise exception 'The selected physical storage location is missing or inactive. Refresh before previewing.'
      using errcode = '23514';
  end if;

  for v_product in
    select product_row.id
    from public.products product_row
    where product_row.id in (
      select distinct line_row.product_id
      from pg_catalog.jsonb_to_recordset(v_request_lines_payload) as line_row(
        product_id uuid,
        status text
      )
      where line_row.status = 'ready'
    )
      and coalesce(product_row.active, false)
    order by product_row.id
    for share
  loop
    v_locked_product_count := v_locked_product_count + 1;
  end loop;
  if v_locked_product_count <> v_requested_product_count then
    raise exception 'A ready historical deduction product is missing or inactive. Refresh before previewing.'
      using errcode = '23514';
  end if;

  -- Keep historical machines available for old corrections, but require every
  -- ready reference to remain a real machine until this transaction commits.
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(v_request_lines_payload) as line_row(
      machine_id uuid,
      status text
    )
    left join public.machines machine_row on machine_row.id = line_row.machine_id
    where line_row.status = 'ready'
      and machine_row.id is null
  ) then
    raise exception 'A ready historical deduction machine no longer exists. Refresh before previewing.'
      using errcode = '23503';
  end if;

  select applied_batch.id
  into v_duplicate_applied_batch_id
  from public.historical_route_deduction_batches applied_batch
  where applied_batch.status = 'applied'
    and pg_catalog.lower(pg_catalog.btrim(applied_batch.content_hash)) = v_content_hash
  order by applied_batch.applied_at desc nulls last, applied_batch.id
  limit 1;

  v_batch_notes := nullif(
    pg_catalog.concat_ws(
      E'\n',
      v_notes,
      case
        when v_duplicate_applied_batch_id is not null
          then 'Warning: matching pasted text was already applied in batch '
            || v_duplicate_applied_batch_id::text || '.'
        else null
      end
    ),
    ''
  );

  -- The preview-only storage before/after fields are calculated from one
  -- database snapshot. They never participate in request identity, so a retry
  -- after stock changes still returns the original immutable preview receipt.
  with source_lines as (
    select line_row.*
    from pg_catalog.jsonb_to_recordset(v_request_lines_payload) as line_row(
      line_number integer,
      section_name text,
      machine_alias text,
      machine_id uuid,
      product_alias text,
      product_id uuid,
      quantity integer,
      original_text text,
      status text,
      review_reason text
    )
  ),
  storage_totals as (
    select
      inventory.product_id,
      coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0)::bigint as quantity_on_hand
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = p_default_storage_location_id
    group by inventory.product_id
  ),
  running_lines as (
    select
      source_line.*,
      case when source_line.status = 'ready' then
        coalesce(storage_total.quantity_on_hand, 0)
          - coalesce(
              pg_catalog.sum(source_line.quantity::bigint) filter (where source_line.status = 'ready') over (
                partition by source_line.product_id
                order by source_line.line_number
                rows between unbounded preceding and 1 preceding
              ),
              0
            )
      else null end as storage_qty_before
    from source_lines source_line
    left join storage_totals storage_total on storage_total.product_id = source_line.product_id
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'line_number', running_line.line_number,
        'section_name', running_line.section_name,
        'machine_alias', running_line.machine_alias,
        'machine_id', running_line.machine_id,
        'product_alias', running_line.product_alias,
        'product_id', running_line.product_id,
        'quantity', running_line.quantity,
        'original_text', running_line.original_text,
        'status', running_line.status,
        'review_reason', running_line.review_reason,
        'storage_location_id', case
          when running_line.status = 'ready' then p_default_storage_location_id
          else null
        end,
        'storage_qty_before', running_line.storage_qty_before::integer,
        'storage_qty_after', case
          when running_line.status = 'ready'
            then (running_line.storage_qty_before - running_line.quantity)::integer
          else null
        end,
        'storage_negative_warning', case
          when running_line.status = 'ready'
            then running_line.storage_qty_before - running_line.quantity < 0
          else false
        end
      )
      order by running_line.line_number
    ),
    '[]'::jsonb
  )
  into v_lines_payload
  from running_lines running_line;

  insert into public.historical_route_deduction_batches (
    status,
    original_text,
    content_hash,
    row_count,
    ready_row_count,
    needs_review_count,
    total_quantity,
    created_by,
    previewed_at,
    notes
  ) values (
    'previewed',
    v_original_text,
    v_content_hash,
    v_row_count,
    v_ready_count,
    v_review_count,
    v_total_quantity::integer,
    v_actor_team_member_id,
    v_now,
    v_batch_notes
  )
  returning * into v_batch;

  insert into public.historical_route_deduction_lines (
    import_batch_id,
    line_number,
    section_name,
    machine_alias,
    machine_id,
    product_alias,
    product_id,
    quantity,
    original_text,
    status,
    review_reason,
    storage_location_id,
    storage_qty_before,
    storage_qty_after,
    storage_negative_warning
  )
  select
    v_batch.id,
    line_row.line_number,
    line_row.section_name,
    line_row.machine_alias,
    line_row.machine_id,
    line_row.product_alias,
    line_row.product_id,
    line_row.quantity,
    line_row.original_text,
    line_row.status,
    line_row.review_reason,
    line_row.storage_location_id,
    line_row.storage_qty_before,
    line_row.storage_qty_after,
    line_row.storage_negative_warning
  from pg_catalog.jsonb_to_recordset(v_lines_payload) as line_row(
    line_number integer,
    section_name text,
    machine_alias text,
    machine_id uuid,
    product_alias text,
    product_id uuid,
    quantity integer,
    original_text text,
    status text,
    review_reason text,
    storage_location_id uuid,
    storage_qty_before integer,
    storage_qty_after integer,
    storage_negative_warning boolean
  )
  order by line_row.line_number;

  if (select pg_catalog.count(*) from public.historical_route_deduction_lines line_row
      where line_row.import_batch_id = v_batch.id) <> v_row_count
  then
    raise exception 'Historical deduction preview did not persist every parsed line.'
      using errcode = '23514';
  end if;

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'client_submission_id', v_submission_id,
    'batch_id', v_batch.id,
    'row_count', v_batch.row_count,
    'ready_row_count', v_batch.ready_row_count,
    'needs_review_count', v_batch.needs_review_count,
    'total_quantity', v_batch.total_quantity,
    'batch_notes', v_batch.notes,
    'previewed_at', v_batch.previewed_at,
    'lines', v_lines_payload
  );

  insert into public.historical_route_deduction_preview_operations (
    client_submission_id,
    actor_user_id,
    actor_team_member_id,
    request_payload,
    batch_id,
    result_payload,
    completed_at
  ) values (
    v_submission_id,
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload,
    v_batch.id,
    v_result_payload,
    v_now
  );

  return query select
    v_batch.id,
    v_batch.row_count,
    v_batch.ready_row_count,
    v_batch.needs_review_count,
    v_batch.total_quantity,
    false;
end;
$function$;

revoke all on function public.snacky_preview_historical_route_deduction_v1(
  text, text, text, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_preview_historical_route_deduction_v1(
  text, text, text, uuid, jsonb
) to authenticated;

do $$
begin
  perform pg_catalog.pg_notify('pgrst', 'reload schema');
end;
$$;
