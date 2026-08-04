begin;

-- In-app instructions replace operational WhatsApp messages with an auditable workflow.
-- Writes are RPC-only. Operators can read only their own instructions and can never edit
-- the original instruction, price snapshot, or assignment.
create table if not exists public.operator_instructions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.team_members(id) on delete cascade,
  instruction_type text not null default 'task'
    check (instruction_type in ('task', 'price_change', 'note')),
  title text not null,
  details text,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  requires_completion boolean not null default true,
  product_id uuid references public.products(id) on delete set null,
  machine_id uuid references public.machines(id) on delete set null,
  route_id uuid references public.routes(id) on delete set null,
  previous_selling_price_lyd numeric(12,2),
  requested_selling_price_lyd numeric(12,2),
  due_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'acknowledged', 'completed', 'cancelled')),
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_by_member_id uuid references public.team_members(id) on delete set null,
  acknowledged_by_user_id uuid references auth.users(id) on delete set null,
  acknowledged_by_member_id uuid references public.team_members(id) on delete set null,
  acknowledged_at timestamptz,
  completed_by_user_id uuid references auth.users(id) on delete set null,
  completed_by_member_id uuid references public.team_members(id) on delete set null,
  completed_at timestamptz,
  completion_note text,
  cancelled_by_user_id uuid references auth.users(id) on delete set null,
  cancelled_by_member_id uuid references public.team_members(id) on delete set null,
  cancelled_at timestamptz,
  cancellation_note text,
  client_submission_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Rerun-safe repair for installations where an earlier attempt created only part of the table.
alter table public.operator_instructions add column if not exists operator_id uuid references public.team_members(id) on delete cascade;
alter table public.operator_instructions add column if not exists instruction_type text not null default 'task';
alter table public.operator_instructions add column if not exists title text;
alter table public.operator_instructions add column if not exists details text;
alter table public.operator_instructions add column if not exists priority text not null default 'normal';
alter table public.operator_instructions add column if not exists requires_completion boolean not null default true;
alter table public.operator_instructions add column if not exists product_id uuid references public.products(id) on delete set null;
alter table public.operator_instructions add column if not exists machine_id uuid references public.machines(id) on delete set null;
alter table public.operator_instructions add column if not exists route_id uuid references public.routes(id) on delete set null;
alter table public.operator_instructions add column if not exists previous_selling_price_lyd numeric(12,2);
alter table public.operator_instructions add column if not exists requested_selling_price_lyd numeric(12,2);
alter table public.operator_instructions add column if not exists due_at timestamptz;
alter table public.operator_instructions add column if not exists status text not null default 'pending';
alter table public.operator_instructions add column if not exists created_by_user_id uuid references auth.users(id) on delete restrict;
alter table public.operator_instructions add column if not exists created_by_member_id uuid references public.team_members(id) on delete set null;
alter table public.operator_instructions add column if not exists acknowledged_by_user_id uuid references auth.users(id) on delete set null;
alter table public.operator_instructions add column if not exists acknowledged_by_member_id uuid references public.team_members(id) on delete set null;
alter table public.operator_instructions add column if not exists acknowledged_at timestamptz;
alter table public.operator_instructions add column if not exists completed_by_user_id uuid references auth.users(id) on delete set null;
alter table public.operator_instructions add column if not exists completed_by_member_id uuid references public.team_members(id) on delete set null;
alter table public.operator_instructions add column if not exists completed_at timestamptz;
alter table public.operator_instructions add column if not exists completion_note text;
alter table public.operator_instructions add column if not exists cancelled_by_user_id uuid references auth.users(id) on delete set null;
alter table public.operator_instructions add column if not exists cancelled_by_member_id uuid references public.team_members(id) on delete set null;
alter table public.operator_instructions add column if not exists cancelled_at timestamptz;
alter table public.operator_instructions add column if not exists cancellation_note text;
alter table public.operator_instructions add column if not exists client_submission_id text;
alter table public.operator_instructions add column if not exists created_at timestamptz not null default now();
alter table public.operator_instructions add column if not exists updated_at timestamptz not null default now();

create unique index if not exists operator_instructions_submission_unique
  on public.operator_instructions(client_submission_id);
create index if not exists operator_instructions_operator_status_idx
  on public.operator_instructions(operator_id, status, created_at desc);
create index if not exists operator_instructions_due_idx
  on public.operator_instructions(operator_id, due_at)
  where status in ('pending', 'acknowledged');
create index if not exists operator_instructions_product_idx
  on public.operator_instructions(product_id, created_at desc)
  where product_id is not null;

alter table public.operator_instructions enable row level security;

drop policy if exists operator_instructions_read on public.operator_instructions;
create policy operator_instructions_read
  on public.operator_instructions
  for select
  to authenticated
  using (
    public.snacky_current_profile_has_any_role(array['owner', 'admin'])
    or operator_id = public.snacky_current_team_member_id()
  );

grant select on public.operator_instructions to authenticated;
grant all on public.operator_instructions to service_role;

create or replace function public.create_operator_instruction(
  p_operator_id uuid,
  p_instruction_type text,
  p_title text,
  p_details text,
  p_priority text,
  p_requires_completion boolean,
  p_product_id uuid,
  p_machine_id uuid,
  p_route_id uuid,
  p_requested_selling_price_lyd numeric,
  p_due_at timestamptz,
  p_client_submission_id text
) returns public.operator_instructions
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_member_id uuid := public.snacky_current_team_member_id();
  v_type text := lower(trim(coalesce(p_instruction_type, 'task')));
  v_priority text := lower(trim(coalesce(p_priority, 'normal')));
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_details text := nullif(trim(coalesce(p_details, '')), '');
  v_submission_id text := nullif(trim(coalesce(p_client_submission_id, '')), '');
  v_previous_price numeric(12,2);
  v_product_name text;
  v_requires_completion boolean;
  v_recipient_user_id uuid;
  v_row public.operator_instructions;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only owner/admin can assign operator instructions' using errcode = '42501';
  end if;
  if v_submission_id is null then
    raise exception 'Client submission ID is required' using errcode = '23514';
  end if;

  select * into v_row
  from public.operator_instructions
  where client_submission_id = v_submission_id;
  if found then
    return v_row;
  end if;

  if v_type not in ('task', 'price_change', 'note') then
    raise exception 'Invalid instruction type' using errcode = '23514';
  end if;
  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid instruction priority' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.team_members tm
    where tm.id = p_operator_id and coalesce(tm.active, true) = true
  ) then
    raise exception 'Operator not found or inactive' using errcode = '23503';
  end if;

  if p_machine_id is not null and not exists (select 1 from public.machines where id = p_machine_id) then
    raise exception 'Machine not found' using errcode = '23503';
  end if;
  if p_route_id is not null and not exists (select 1 from public.routes where id = p_route_id) then
    raise exception 'Route not found' using errcode = '23503';
  end if;

  v_requires_completion := coalesce(p_requires_completion, v_type <> 'note');

  if v_type = 'price_change' then
    if p_product_id is null then
      raise exception 'Product is required for a price change' using errcode = '23514';
    end if;
    if p_requested_selling_price_lyd is null or p_requested_selling_price_lyd <= 0 then
      raise exception 'New selling price must be greater than zero' using errcode = '23514';
    end if;

    select
      p.name,
      coalesce(p.current_selling_price_lyd, p.selling_price, 0)::numeric(12,2)
    into v_product_name, v_previous_price
    from public.products p
    where p.id = p_product_id and coalesce(p.active, true) = true
    for update;
    if not found then
      raise exception 'Product not found or inactive' using errcode = '23503';
    end if;
    if v_previous_price = round(p_requested_selling_price_lyd, 2) then
      raise exception 'The new selling price is the same as the current price' using errcode = '23514';
    end if;

    update public.products
    set selling_price = round(p_requested_selling_price_lyd, 2),
        current_selling_price_lyd = round(p_requested_selling_price_lyd, 2),
        selling_price_source = 'manual',
        price_updated_at = now()
    where id = p_product_id;

    v_title := coalesce(
      v_title,
      format('Change %s selling price to %s LYD', v_product_name, round(p_requested_selling_price_lyd, 2))
    );
    v_requires_completion := true;
  elsif v_type = 'note' then
    v_title := coalesce(v_title, 'Operator note');
    v_requires_completion := false;
  elsif v_title is null then
    raise exception 'Task title is required' using errcode = '23514';
  end if;

  insert into public.operator_instructions (
    operator_id,
    instruction_type,
    title,
    details,
    priority,
    requires_completion,
    product_id,
    machine_id,
    route_id,
    previous_selling_price_lyd,
    requested_selling_price_lyd,
    due_at,
    status,
    created_by_user_id,
    created_by_member_id,
    client_submission_id
  ) values (
    p_operator_id,
    v_type,
    v_title,
    v_details,
    v_priority,
    v_requires_completion,
    p_product_id,
    p_machine_id,
    p_route_id,
    v_previous_price,
    case when v_type = 'price_change' then round(p_requested_selling_price_lyd, 2) else null end,
    p_due_at,
    'pending',
    v_actor_user_id,
    v_actor_member_id,
    v_submission_id
  )
  returning * into v_row;

  -- Save an in-app notification when the existing notification module is installed.
  if to_regclass('public.notifications') is not null then
    select p.id into v_recipient_user_id
    from public.profiles p
    where p.team_member_id = p_operator_id
    limit 1;

    if v_recipient_user_id is null then
      select tm.auth_user_id into v_recipient_user_id
      from public.team_members tm
      where tm.id = p_operator_id;
    end if;

    if v_recipient_user_id is not null then
      execute $notification$
        insert into public.notifications (
          user_id, type, title, message, action_url, related_route_id
        ) values ($1, $2, $3, $4, $5, $6)
      $notification$
      using
        v_recipient_user_id,
        'operator_instruction:' || v_row.id::text,
        'تعليمات جديدة من سناكي',
        v_row.title,
        '/operator/routes#operator-instructions',
        v_row.route_id;
    end if;
  end if;

  return v_row;
end
$$;

grant execute on function public.create_operator_instruction(
  uuid, text, text, text, text, boolean, uuid, uuid, uuid, numeric, timestamptz, text
) to authenticated;

create or replace function public.advance_operator_instruction(
  p_instruction_id uuid,
  p_action text,
  p_note text
) returns public.operator_instructions
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_member_id uuid := public.snacky_current_team_member_id();
  v_manager boolean := public.snacky_current_profile_has_any_role(array['owner', 'admin']);
  v_action text := lower(trim(coalesce(p_action, '')));
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_row public.operator_instructions;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_row
  from public.operator_instructions
  where id = p_instruction_id
  for update;
  if not found then
    raise exception 'Instruction not found' using errcode = 'P0002';
  end if;

  if not v_manager and (v_actor_member_id is null or v_actor_member_id <> v_row.operator_id) then
    raise exception 'You can only update your own instructions' using errcode = '42501';
  end if;

  if v_action = 'acknowledge' then
    if v_row.status = 'cancelled' then
      raise exception 'Cancelled instruction cannot be acknowledged' using errcode = '23514';
    end if;
    if v_row.status = 'pending' then
      update public.operator_instructions
      set status = 'acknowledged',
          acknowledged_by_user_id = v_actor_user_id,
          acknowledged_by_member_id = v_actor_member_id,
          acknowledged_at = now(),
          updated_at = now()
      where id = p_instruction_id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  if v_action = 'complete' then
    if v_row.status = 'completed' then
      return v_row;
    end if;
    if v_row.status = 'cancelled' then
      raise exception 'Cancelled instruction cannot be completed' using errcode = '23514';
    end if;

    update public.operator_instructions
    set status = 'completed',
        acknowledged_by_user_id = coalesce(acknowledged_by_user_id, v_actor_user_id),
        acknowledged_by_member_id = coalesce(acknowledged_by_member_id, v_actor_member_id),
        acknowledged_at = coalesce(acknowledged_at, now()),
        completed_by_user_id = v_actor_user_id,
        completed_by_member_id = v_actor_member_id,
        completed_at = now(),
        completion_note = v_note,
        updated_at = now()
    where id = p_instruction_id
    returning * into v_row;

    if to_regclass('public.notifications') is not null
       and v_row.created_by_user_id is not null
       and v_row.created_by_user_id <> v_actor_user_id then
      execute $notification$
        insert into public.notifications (
          user_id, type, title, message, action_url, related_route_id
        ) values ($1, $2, $3, $4, $5, $6)
      $notification$
      using
        v_row.created_by_user_id,
        'operator_instruction_completed:' || v_row.id::text,
        'تم تنفيذ تعليمات المشغّل',
        v_row.title,
        '/team/' || v_row.operator_id::text || '#operator-instructions',
        v_row.route_id;
    end if;

    return v_row;
  end if;

  if v_action = 'cancel' then
    if not v_manager then
      raise exception 'Only owner/admin can cancel instructions' using errcode = '42501';
    end if;
    if v_row.status = 'completed' then
      raise exception 'Completed instruction cannot be cancelled' using errcode = '23514';
    end if;
    if v_row.status <> 'cancelled' then
      update public.operator_instructions
      set status = 'cancelled',
          cancelled_by_user_id = v_actor_user_id,
          cancelled_by_member_id = v_actor_member_id,
          cancelled_at = now(),
          cancellation_note = v_note,
          updated_at = now()
      where id = p_instruction_id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  raise exception 'Invalid instruction action' using errcode = '23514';
end
$$;

grant execute on function public.advance_operator_instruction(uuid, text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
commit;
