# Local Development

This document contains local-only setup notes for Snacky OS.

## Start Local Supabase

On Windows, start Supabase without optional services that are not needed for the
current Snacky OS app:

```bash
npx supabase start -x logflare,imgproxy,edge-runtime,supavisor
```

Do not use `analytics`, `storage`, or `pooler` in the exclude list. Newer
Supabase CLI versions expect the container names `logflare`, `storage-api`, and
`supavisor`. Keep `storage-api` running because product image uploads use
Supabase Storage.

Analytics is disabled in `supabase/config.toml` because the local Logflare
container can fail health checks on Windows unless Docker exposes the daemon on
`tcp://localhost:2375`.

Local Storage is enabled in `supabase/config.toml` with the same bucket names as
production: `product-images`, `receipt-images`, `machine-photos`,
`refill-photos`, and `issue-photos`.

See `docs/STORAGE_SETUP.md` for bucket visibility, upload limits, and the
expected local fallback behavior when Storage is unavailable.

## Docker Desktop Engine Error

If `npx supabase start` fails with an error like:

```text
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified
```

Supabase cannot reach Docker Desktop's Linux engine. Docker Desktop may be open
while the backend engine is stopped or not installed correctly.

Check from PowerShell:

```bash
docker context ls
docker --context desktop-linux version
wsl -l -v
```

Expected state:

- `desktop-linux` is the active Docker context.
- `docker --context desktop-linux version` shows both `Client` and `Server`.
- `wsl -l -v` shows Docker's WSL distributions or a usable WSL2 distribution.

If `wsl -l -v` says there are no installed distributions, install/repair WSL2
and restart Docker Desktop:

```bash
wsl --install
wsl --set-default-version 2
```

Then open Docker Desktop, wait until it says the engine is running, and retry:

```bash
npx supabase start -x logflare,imgproxy,edge-runtime,supavisor
```

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
