# Local Development

This document contains local-only setup notes for Snacky OS.

## Local Supabase Reset

To rebuild the local database from migrations and seed data:

```bash
npx supabase db reset
```

This deletes local manual data and recreates the database from migrations plus `supabase/seed.sql`.

Never run production resets. Production data must be preserved.

## Local Login Users

The following users are seeded for local development only.

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@snacky.local` | `admin123` |
| Operator | `operator@snacky.local` | `operator123` |

These credentials are not production credentials. Do not reuse these passwords in hosted environments, demos with real data, staging, or production.

The seed links each auth user to a `team_members` row through:

```text
auth.users.id -> team_members.auth_user_id -> team_members.id -> profiles.team_member_id
```

The local operator account is useful for testing assigned route access and operator mobile workflows. The local admin account is useful for route planning, inventory, team, and master-data workflows.
