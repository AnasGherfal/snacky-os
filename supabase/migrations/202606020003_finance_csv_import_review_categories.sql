insert into public.finance_categories (name, type, is_active)
values
  ('Revenue', 'income', true),
  ('Ads Income', 'income', true),
  ('Product Restocking', 'expense', true),
  ('Rent', 'expense', true),
  ('Salary / Employee Payment', 'expense', true),
  ('Operator Payment', 'expense', true),
  ('Commute', 'expense', true),
  ('Maintenance', 'expense', true),
  ('Machine Purchase', 'expense', true),
  ('Shipping', 'expense', true),
  ('Customs', 'expense', true),
  ('Marketing / Ads', 'expense', true),
  ('Charity', 'expense', true),
  ('Refund', 'both', true),
  ('Owner Funding', 'transfer', true),
  ('Owner Withdrawal', 'transfer', true),
  ('Bank / Exchange', 'transfer', true),
  ('Miscellaneous', 'both', true),
  ('Uncategorized', 'both', true),
  ('Other', 'both', true)
on conflict (name) do update
set type = excluded.type,
    is_active = excluded.is_active;
