-- Dedicated lightweight CRM role for customer support and field business development.
-- Keep this enum addition in its own migration so later migrations can safely
-- reference the new enum value after the transaction commits.

alter type public.team_role add value if not exists 'crm';
