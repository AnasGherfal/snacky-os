do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'customer_compensation'
  ) then
    alter type public.movement_reason add value 'customer_compensation';
  end if;
end $$;
