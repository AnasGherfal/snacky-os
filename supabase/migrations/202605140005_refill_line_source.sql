alter table refill_order_lines
add column if not exists source text not null default 'refill_recommendation';

do $$ begin
  alter table refill_order_lines
    add constraint refill_order_lines_source_check
    check (source in ('refill_recommendation', 'manual_admin_assignment'));
exception when duplicate_object then null; end $$;
