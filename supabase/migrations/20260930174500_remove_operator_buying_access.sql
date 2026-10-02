-- Keep route operators out of purchasing/buying workflows.
-- Operators collect/refill machines; buying lists belong to purchasing-capable staff.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function buying_private.member()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.profiles p
  join public.team_members t on t.id = p.team_member_id
  where p.id = auth.uid()
    and p.active_status = 'active'
    and t.active_status = 'active'
    and t.active is true
    and public.snacky_current_profile_has_any_role(
      array['owner','admin','supervisor','warehouse','purchasing','finance']
    )
  limit 1;
$$;

create or replace function buying_private.workspace(p_id uuid, p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := buying_private.member();
  plan boolean := buying_private.planner();
  list_data jsonb;
  rows jsonb;
  total integer;
  people jsonb := '[]';
  off integer := greatest(0, least(coalesce((p_filters->>'offset')::integer, 0), 100000));
  wanted text := coalesce(p_filters->>'status', 'open');
  scope text := coalesce(p_filters->>'scope', 'mine');
begin
  if me is null then
    raise exception 'Active buying staff access required' using errcode = '42501';
  end if;
  if wanted not in ('open','completed','cancelled','all') or scope not in ('mine','all') then
    raise exception 'Invalid filters' using errcode = '22023';
  end if;

  if p_id is not null then
    if not buying_private.visible(p_id) then
      raise exception 'List access denied' using errcode = '42501';
    end if;
    select to_jsonb(l) || jsonb_build_object(
      'buyer_name', b.full_name,
      'creator_name', c.full_name,
      'items', (
        select jsonb_agg(to_jsonb(i) order by i.position)
        from buying_private.items i
        where i.list_id = l.id
      )
    )
    into list_data
    from buying_private.lists l
    join public.team_members b on b.id = l.assigned_to
    join public.team_members c on c.id = l.created_by
    where l.id = p_id;
  end if;

  with permitted as (
    select
      l.*,
      b.full_name buyer_name,
      c.full_name creator_name,
      (select count(*) from buying_private.items i where i.list_id = l.id) item_count,
      (select count(*) from buying_private.items i where i.list_id = l.id and i.outcome <> 'pending') checked_count
    from buying_private.lists l
    join public.team_members b on b.id = l.assigned_to
    join public.team_members c on c.id = l.created_by
    where buying_private.visible(l.id)
      and (scope = 'all' or l.assigned_to = me)
      and (wanted = 'all' or l.status = wanted)
  ),
  page as (
    select *
    from permitted
    order by due_on, created_at desc, id
    limit 30 offset off
  )
  select
    (select count(*) from permitted),
    coalesce((select jsonb_agg(to_jsonb(p) order by p.due_on, p.created_at desc, p.id) from page p), '[]')
  into total, rows;

  if plan then
    select coalesce(
      jsonb_agg(jsonb_build_object('id', t.id, 'name', t.full_name) order by t.full_name),
      '[]'
    )
    into people
    from public.team_members t
    where t.active is true
      and t.active_status = 'active'
      and exists (
        select 1
        from public.profiles p
        where p.team_member_id = t.id
          and p.active_status = 'active'
          and (coalesce(p.roles::text[], '{}') || array[p.role::text])
            && array['owner','admin','supervisor','warehouse','purchasing','finance']
      );
  end if;

  return jsonb_build_object(
    'me', me,
    'planner', plan,
    'today', (now() at time zone 'Africa/Tripoli')::date,
    'record', list_data,
    'rows', rows,
    'total', total,
    'offset', off,
    'people', people
  );
end;
$$;

notify pgrst, 'reload schema';
commit;
