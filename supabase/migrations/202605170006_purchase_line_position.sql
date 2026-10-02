alter table purchase_order_lines
  add column if not exists line_position integer not null default 0;

with ranked as (
  select
    id,
    row_number() over (partition by purchase_order_id order by created_at, id) - 1 as position
  from purchase_order_lines
)
update purchase_order_lines pol
set line_position = ranked.position
from ranked
where pol.id = ranked.id
  and pol.line_position = 0;

create index if not exists idx_purchase_order_lines_position on purchase_order_lines(purchase_order_id, line_position);
