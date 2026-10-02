-- Allow the app to determine whether a team member can be permanently deleted
-- without losing operational/audit history. The check is intentionally dynamic:
-- future foreign keys that reference team_members are included automatically.

create or replace function public.snacky_team_member_delete_blockers(p_team_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  fk record;
  ref_count bigint;
  blockers jsonb := '[]'::jsonb;
begin
  for fk in
    select
      ns.nspname as schema_name,
      cls.relname as table_name,
      att.attname as column_name
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace ns on ns.oid = cls.relnamespace
    join lateral unnest(con.conkey) with ordinality as cols(attnum, ord) on true
    join lateral unnest(con.confkey) with ordinality as refcols(attnum, ord)
      on refcols.ord = cols.ord
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = cols.attnum
    join pg_attribute refatt
      on refatt.attrelid = con.confrelid
     and refatt.attnum = refcols.attnum
    where con.contype = 'f'
      and con.confrelid = 'public.team_members'::regclass
      and refatt.attname = 'id'
      and ns.nspname = 'public'
      -- Login/profile rows are cleanup records, not operational history.
      and cls.relname <> 'profiles'
    order by cls.relname, att.attname
  loop
    execute format(
      'select count(*) from %I.%I where %I = $1',
      fk.schema_name,
      fk.table_name,
      fk.column_name
    )
    into ref_count
    using p_team_member_id;

    if ref_count > 0 then
      blockers := blockers || jsonb_build_array(
        jsonb_build_object(
          'table', fk.table_name,
          'column', fk.column_name,
          'count', ref_count
        )
      );
    end if;
  end loop;

  return blockers;
end;
$$;

revoke all on function public.snacky_team_member_delete_blockers(uuid) from public;
revoke all on function public.snacky_team_member_delete_blockers(uuid) from anon;
revoke all on function public.snacky_team_member_delete_blockers(uuid) from authenticated;
grant execute on function public.snacky_team_member_delete_blockers(uuid) to service_role;
