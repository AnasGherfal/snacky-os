alter table cash_collections
  alter column review_status set default 'ok';

update cash_collections
set review_status = case
  when review_status = 'resolved' then 'resolved'
  when abs(variance) >= 10 then 'needs_review'
  else 'ok'
end
where review_status is null
  or review_status not in ('ok', 'needs_review', 'resolved');

alter table cash_collections
  drop constraint if exists cash_collections_review_status_check;

alter table cash_collections
  add constraint cash_collections_review_status_check
  check (review_status in ('ok', 'needs_review', 'resolved'));
