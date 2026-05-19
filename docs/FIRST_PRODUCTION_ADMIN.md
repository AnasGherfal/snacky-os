# First Production Admin Setup

Use this once per new Supabase Cloud project before inviting operators.

Do not use the local development users from `supabase/seed.sql` in production.

## Recommended: Use The First Owner Script

From the repository root, point your shell at the Supabase Cloud project and run:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-or-secret-key \
npm run create:first-owner -- --confirm-production-owner --generate-password
```

PowerShell:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="https://your-project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-or-secret-key"
npm run create:first-owner -- --confirm-production-owner --generate-password
```

The script defaults to:

- Email: `anas@snacky.ly`
- Name: `Anas`
- Role: `owner`

It creates or repairs all three required records:

- Supabase Auth user
- `public.team_members`
- `public.profiles`

It refuses local Supabase URLs unless `--allow-local` is passed.

If you want to choose the temporary password yourself, set it with an environment variable instead of `--generate-password`:

```bash
SNACKY_FIRST_OWNER_TEMP_PASSWORD='replace-with-a-strong-temp-password' \
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-or-secret-key \
npm run create:first-owner -- --confirm-production-owner
```

PowerShell:

```powershell
$env:SNACKY_FIRST_OWNER_TEMP_PASSWORD="replace-with-a-strong-temp-password"
$env:NEXT_PUBLIC_SUPABASE_URL="https://your-project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-or-secret-key"
npm run create:first-owner -- --confirm-production-owner
```

After it succeeds, open `/login`, sign in as `anas@snacky.ly`, then change the password from `/account`.

## Manual Fallback

Use this if you prefer to create the user through the Supabase Dashboard.

## 1. Create The Auth User

In Supabase Dashboard:

1. Open Authentication > Users.
2. Create a new user with the real owner's email.
3. Set a temporary password.
4. Confirm the email if your project requires confirmation.
5. Copy the user's Auth User ID.

## 2. Link The User To Snacky OS

Open Supabase SQL Editor and run this with real values.

Replace:

- `<AUTH_USER_ID>` with the Auth User ID from Supabase.
- `<ADMIN_EMAIL>` with the same real email.
- `<ADMIN_NAME>` with the real full name.

```sql
begin;

with updated_team_member as (
  update public.team_members
  set
    full_name = '<ADMIN_NAME>',
    email = '<ADMIN_EMAIL>',
    role = 'owner',
    active = true,
    auth_user_id = '<AUTH_USER_ID>'::uuid,
    active_status = 'active',
    must_change_password = true
  where auth_user_id = '<AUTH_USER_ID>'::uuid
     or email = '<ADMIN_EMAIL>'
  returning id
),
inserted_team_member as (
  insert into public.team_members (
    full_name,
    email,
    phone,
    role,
    active,
    auth_user_id,
    active_status,
    must_change_password
  )
  select
    '<ADMIN_NAME>',
    '<ADMIN_EMAIL>',
    null,
    'owner',
    true,
    '<AUTH_USER_ID>'::uuid,
    'active',
    true
  where not exists (select 1 from updated_team_member)
  returning id
),
admin_team_member as (
  select id from updated_team_member
  union all
  select id from inserted_team_member
  limit 1
)
insert into public.profiles (
  id,
  full_name,
  email,
  phone,
  role,
  active_status,
  team_member_id,
  must_change_password
)
select
  '<AUTH_USER_ID>'::uuid,
  '<ADMIN_NAME>',
  '<ADMIN_EMAIL>',
  null,
  'owner',
  'active',
  id,
  true
from admin_team_member
on conflict (id) do update set
  full_name = excluded.full_name,
  email = excluded.email,
  phone = excluded.phone,
  role = excluded.role,
  active_status = excluded.active_status,
  team_member_id = excluded.team_member_id,
  must_change_password = excluded.must_change_password,
  updated_at = now();

commit;
```

## 3. Sign In

1. Open the deployed Snacky OS URL.
2. Sign in with the real admin email and temporary password.
3. Change the password from the account screen if prompted or required.
4. Open `/team` and create real users for supervisors, operators, warehouse, procurement, and finance.

Creating or resetting login access from the Team screens requires `SUPABASE_SERVICE_ROLE_KEY` in Vercel.

## 4. Remove Any Test Users

Before letting others test:

1. Confirm no `@snacky.local` Auth users exist in Supabase.
2. Confirm no `@snacky.local` rows exist in `public.team_members`.
3. Confirm no `@snacky.local` rows exist in `public.profiles`.

Useful checks:

```sql
select email from auth.users where email ilike '%@snacky.local';
select email from public.team_members where email ilike '%@snacky.local';
select email from public.profiles where email ilike '%@snacky.local';
```
