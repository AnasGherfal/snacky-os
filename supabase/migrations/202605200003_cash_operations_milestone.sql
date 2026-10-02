alter type movement_reason add value if not exists 'opening_balance';

alter table cash_collections
  add column if not exists cash_bag_id text,
  add column if not exists counted_at timestamptz,
  add column if not exists counted_by uuid references team_members(id) on delete set null,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists void_reason text,
  alter column vms_expected_cash drop not null,
  alter column vms_expected_cash drop default,
  alter column actual_cash_collected drop not null,
  alter column actual_cash_collected drop default;

update cash_collections
set review_status = case
  when review_status in ('resolved', 'ok') then 'counted_confirmed'
  when review_status in ('needs_review', 'review_required') then 'variance_review'
  when review_status in ('pending', 'pending_collection') then 'pending_collection'
  else 'pending_collection'
end
where review_status is null
   or review_status not in ('pending_collection', 'collected_pending_count', 'counted_confirmed', 'variance_review', 'voided');

alter table cash_collections
  drop constraint if exists cash_collections_review_status_check;

alter table cash_collections
  add constraint cash_collections_review_status_check
  check (review_status in ('pending_collection', 'collected_pending_count', 'counted_confirmed', 'variance_review', 'voided'));

update purchase_orders
set payment_status = 'partially_paid'
where payment_status = 'partial';

alter table purchase_orders
  drop constraint if exists purchase_orders_payment_status_check;

alter table purchase_orders
  add constraint purchase_orders_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'partially_paid', 'voided'));

create index if not exists idx_cash_collections_status_date
  on cash_collections(review_status, collected_at desc);

create index if not exists idx_cash_collections_machine_date
  on cash_collections(machine_id, collected_at desc);

create index if not exists idx_cash_collections_operator_date
  on cash_collections(operator_id, collected_at desc);
