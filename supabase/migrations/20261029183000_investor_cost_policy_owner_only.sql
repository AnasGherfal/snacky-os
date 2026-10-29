-- Internal cost planning includes unapproved salaries and other private management notes.
-- Investors can review the recorded expenses in their finalized monthly statements,
-- but must not read the underlying owner-only planning table through the public API.
alter table public.investor_cost_policies enable row level security;

drop policy if exists investor_cost_policies_owner_read on public.investor_cost_policies;

create policy investor_cost_policies_owner_read
  on public.investor_cost_policies
  for select to authenticated
  using (public.snacky_is_owner_admin());

-- Keep existing owner-only write policy and all historical accounting rows intact.
