do $patch$
declare
  ddl text;
  old_sql text := $old$select coalesce(jsonb_agg(value||jsonb_build_object('labels',crm_collab_private.labels_for_workspace((value->>'id')::uuid,collab_active,collab_manager,actor)) order by ord),'[]'::jsonb) into rows from jsonb_array_elements(rows) with ordinality as x(value,ord);$old$;
  new_sql text := $new$with page_rows as (
    select value,ord,(value->>'id')::uuid as lead_id
    from jsonb_array_elements(rows) with ordinality as x(value,ord)
  ),page_labels as (
    select x.lead_id,
      jsonb_agg(
        jsonb_build_object(
          'id',l.id,'name',l.name,'color',l.color,
          'owner_id',l.owner_id,'owner_name',p.full_name
        )
        order by l.name,l.id
      ) as labels
    from crm_collab_private.lead_labels x
    join crm_collab_private.labels l on l.id=x.label_id
    join public.profiles p on p.id=l.owner_id
    where collab_active and not l.archived
      and (collab_manager or l.owner_id=actor)
      and x.lead_id in (select lead_id from page_rows)
    group by x.lead_id
  )
  select coalesce(
    jsonb_agg(
      pr.value||jsonb_build_object('labels',coalesce(pl.labels,'[]'::jsonb))
      order by pr.ord
    ),
    '[]'::jsonb
  )
  into rows
  from page_rows pr
  left join page_labels pl on pl.lead_id=pr.lead_id;$new$;
begin
  select pg_get_functiondef('crm_lead_private.workspace(jsonb)'::regprocedure) into ddl;
  if ddl is null then raise exception 'crm_lead_private.workspace not found'; end if;

  if position(new_sql in ddl) > 0 then return; end if;
  if position(old_sql in ddl) = 0 then raise exception 'lead label expansion anchor not found'; end if;

  execute replace(ddl,old_sql,new_sql);
end
$patch$;

select pg_notify('pgrst','reload schema');
