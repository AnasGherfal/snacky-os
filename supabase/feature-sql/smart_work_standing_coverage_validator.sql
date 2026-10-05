-- Smart Work standing responsibility: primary ownership is durable; random hours are not guessed.
-- This migration changes configuration validation and duty ownership only. It creates no duties, routes or inventory movements.
create or replace function public.snacky_valid_smart_coverage(p_kind text, v jsonb)
returns boolean language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare w jsonb; d jsonb; used_days integer[] := '{}'; start_min integer; end_min integer;
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'enabled') is distinct from 'boolean' then return false; end if;
  if p_kind='machine' then
    if v->>'mode'='standing' then
      if not v ?& array['primaryId','backupId','mode','enabled'] or (select count(*) from jsonb_object_keys(v))<>4 then return false; end if;
      if jsonb_typeof(v->'primaryId') is distinct from 'string' or (v->>'primaryId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
      if v->'backupId'<>'null'::jsonb and (jsonb_typeof(v->'backupId') is distinct from 'string' or (v->>'backupId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
      if v->>'primaryId'=v->>'backupId' then return false; end if;
      return true;
    end if;
    if not v ?& array['primaryId','backupId','days','accessStart','accessEnd','travelMinutes','serviceMinutes','enabled']
      or (select count(*) from jsonb_object_keys(v))<>8 then return false; end if;
    if jsonb_typeof(v->'primaryId') is distinct from 'string' or (v->>'primaryId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    if v->'backupId'<>'null'::jsonb and (jsonb_typeof(v->'backupId') is distinct from 'string' or (v->>'backupId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
    if v->>'primaryId'=v->>'backupId' then return false; end if;
    if jsonb_typeof(v->'days') is distinct from 'array' or jsonb_array_length(v->'days') not between 1 and 7 then return false; end if;
    for d in select * from jsonb_array_elements(v->'days') loop
      if jsonb_typeof(d)<>'number' or d::text !~ '^[1-7]$' or d::text::integer=any(used_days) then return false; end if;
      used_days:=array_append(used_days,d::text::integer);
    end loop;
    if jsonb_typeof(v->'accessStart') is distinct from 'string' or jsonb_typeof(v->'accessEnd') is distinct from 'string'
      or (v->>'accessStart') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (v->>'accessEnd') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
    start_min:=split_part(v->>'accessStart',':',1)::int*60+split_part(v->>'accessStart',':',2)::int;
    end_min:=split_part(v->>'accessEnd',':',1)::int*60+split_part(v->>'accessEnd',':',2)::int;
    if end_min<=start_min or jsonb_typeof(v->'serviceMinutes') is distinct from 'number' or jsonb_typeof(v->'travelMinutes') is distinct from 'number'
      or (v->>'serviceMinutes') !~ '^[0-9]+$' or (v->>'travelMinutes') !~ '^[0-9]+$' then return false; end if;
    if (v->>'serviceMinutes')::int not between 1 and 480 or (v->>'travelMinutes')::int not between 0 and 480
      or (v->>'serviceMinutes')::int>end_min-start_min then return false; end if;
    return true;
  elsif p_kind='operator' then
    if not v ?& array['enabled','windows'] or (select count(*) from jsonb_object_keys(v))<>2
      or jsonb_typeof(v->'windows') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'windows')>7 or ((v->>'enabled')::boolean and jsonb_array_length(v->'windows')=0) then return false; end if;
    for w in select * from jsonb_array_elements(v->'windows') loop
      if jsonb_typeof(w) is distinct from 'object' or not w ?& array['day','start','end','minutes']
        or (select count(*) from jsonb_object_keys(w))<>4 then return false; end if;
      if jsonb_typeof(w->'day') is distinct from 'number' or (w->>'day') !~ '^[1-7]$' or (w->>'day')::int=any(used_days) then return false; end if;
      used_days:=array_append(used_days,(w->>'day')::int);
      if jsonb_typeof(w->'start') is distinct from 'string' or jsonb_typeof(w->'end') is distinct from 'string'
        or (w->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (w->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
      start_min:=split_part(w->>'start',':',1)::int*60+split_part(w->>'start',':',2)::int;
      end_min:=split_part(w->>'end',':',1)::int*60+split_part(w->>'end',':',2)::int;
      if end_min<=start_min or jsonb_typeof(w->'minutes') is distinct from 'number' or (w->>'minutes') !~ '^[0-9]+$' then return false; end if;
      if (w->>'minutes')::int not between 1 and 960 or (w->>'minutes')::int>end_min-start_min then return false; end if;
    end loop;
    return true;
  end if;
  return false;
exception when others then return false;
end $$;
revoke all on function public.snacky_valid_smart_coverage(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.snacky_valid_smart_coverage(text,jsonb) to service_role;
