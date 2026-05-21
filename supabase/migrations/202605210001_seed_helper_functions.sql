create or replace function public.snacky_seed_clean_text(value text)
returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(value, '')) = '' then null
    when upper(btrim(coalesce(value, ''))) = 'TO_CONFIRM' then null
    else btrim(value)
  end
$$;

create or replace function public.snacky_seed_numeric(value text)
returns numeric
language sql
immutable
as $$
  select case
    when public.snacky_seed_clean_text(value) ~ '^-?[0-9]+(\.[0-9]+)?$'
      then public.snacky_seed_clean_text(value)::numeric
    else null
  end
$$;

create or replace function public.snacky_seed_date(value text)
returns date
language plpgsql
immutable
as $$
begin
  if public.snacky_seed_clean_text(value) is null then
    return null;
  end if;

  return public.snacky_seed_clean_text(value)::date;
exception when others then
  return null;
end;
$$;
