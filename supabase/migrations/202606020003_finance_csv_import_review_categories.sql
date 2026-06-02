insert into public.finance_categories (name, type, is_active)
values
  ('Revenue', 'income', true),
  ('Products Restocking', 'expense', true),
  ('Rent', 'expense', true),
  ('Salary / Employee Payment', 'expense', true),
  ('Charity', 'expense', true),
  ('Ads', 'income', true),
  ('Shipping', 'expense', true),
  ('Maintenance', 'expense', true),
  ('Machine Purchase', 'expense', true),
  ('Marketing', 'expense', true),
  ('Refund', 'both', true),
  ('Owner Funding', 'transfer', true),
  ('Owner Withdrawal', 'transfer', true),
  ('Exchange', 'transfer', true),
  ('Miscellaneous', 'both', true),
  ('Uncategorized', 'both', true),
  ('Other', 'both', true)
on conflict (name) do update
set type = excluded.type,
    is_active = excluded.is_active;

update public.finance_categories
set is_active = false
where name in (
  'Sales Revenue',
  'Ad Revenue',
  'Ads Income',
  'Product Purchase',
  'Product Restocking',
  'Delivery / Transport',
  'Operator Payment',
  'Commute',
  'Customs',
  'Marketing / Ads',
  'Bank / Exchange'
);
