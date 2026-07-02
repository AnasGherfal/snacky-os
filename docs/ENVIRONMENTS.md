# Snacky OS Environments

Snacky OS should run in three clearly separated environments: local development, staging, and production. Each environment must point to the matching Supabase project and app domain.

## Environment Matrix

| Environment | App host | Supabase project | Data purpose | Reset allowed |
| --- | --- | --- | --- | --- |
| Local development | `localhost` or `127.0.0.1` | Local Supabase by default, or staging Supabase when intentionally configured | Developer testing, UI work, local imports | Yes, local only |
| Staging | Vercel Preview or staging domain | Supabase staging | Release testing with copied or sanitized business data | No |
| Production | Vercel production domain | Supabase production | Real Snacky operations data | Never |

## Local Development

Local development normally uses local Supabase started from this repository:

```bash
npx supabase start -x logflare,imgproxy,edge-runtime,supavisor
```

Local `.env.local` can point to either:

- Local Supabase, for isolated development.
- Supabase staging, when testing cloud Auth, Storage, or staging data flows intentionally.

Do not point a local development app at production unless you are doing a controlled production support task and understand the data impact. Never run local import/reset scripts against production.

## Staging

Staging uses:

- Supabase staging project.
- Vercel staging or Preview deployment.
- Cloud environment variables from the Supabase staging project.
- Auth redirect URLs that include the staging app domain.

Use staging for release checks, role testing, VMS imports, purchase receiving, cash collection review, and PWA install verification before production.

## Production

Production uses:

- Supabase production project.
- Vercel production deployment.
- Cloud environment variables from the Supabase production project.
- Auth redirect URLs that include the production app domain.

Production contains real business history. Do not run `supabase db reset`, demo seed data, or destructive test imports against production. Run the cloud-safe business seed only when you intentionally want the local business dataset in that environment.

## Environment Variables

Each Vercel environment must have values from the matching Supabase project:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-or-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-or-secret-key
NEXT_PUBLIC_APP_URL=https://your-snacky-os-domain.example
NEXT_PUBLIC_APP_LOCALE=en
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your-web-push-public-key
VAPID_PRIVATE_KEY=your-server-only-web-push-private-key
VAPID_SUBJECT=mailto:ops@snacky.example
```

Rules:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are public browser values, but still must point to the correct environment.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never be exposed through `NEXT_PUBLIC_*`.
- `NEXT_PUBLIC_APP_URL` must match the Vercel domain for the environment.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is public browser configuration for push subscriptions.
- `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are server-only and must never be exposed through `NEXT_PUBLIC_*`.
- Staging and production must not use local Supabase URLs.

Optional server-only provider variables:

```bash
XY_VMS_ENABLED=true
XY_VMS_BASE_URL=https://xcx.xynetweb.com/service-api/api
XY_VMS_MERCHANT_ID=6591
XY_VMS_KEY=your-xy-key
XY_VMS_SECRET=your-xy-secret
XY_VMS_SIGNING_MODE=signed
XY_VMS_TIMEOUT_MS=20000
```

Optional server-only XY web dashboard fallback variables:

```bash
XY_WEB_API_BASE_URL=https://xcx.xynetweb.com/sram
XY_WEB_API_AUTHORIZATION=your-current-web-dashboard-authorization-token
XY_WEB_MERCHANT_ID=6591
XY_WEB_LANGUAGE=en
XY_WEB_CHANNEL=1
XY_WEB_ENABLED=true
```

Rules:

- XY VMS credentials are server-only and must never use `NEXT_PUBLIC_`.
- XY web dashboard Authorization tokens are temporary server-only values. Do not store them in the database, browser code, screenshots, or commits.
- Staging and production should use separate provider credentials if the provider supports it.
- If a provider only offers production credentials, test imports in staging with uploaded XLS/XLSX/CSV files instead of live sync.
- Any local URL in Vercel Preview or Production environment variables is a release blocker.

## Schema And Data Changes

Use migrations for schema changes:

```bash
npx supabase db push
```

Rules:

- Local reset is allowed only for local development.
- Never run `supabase db reset` on production.
- `supabase/seed.sql` is business-data only and can be run intentionally with `npx supabase db push --include-seed`; test this in staging before production.
- Use bootstrap/import flows for larger initial real-data loads.
- Test imports in staging before production.

Initial data should come from:

- The first production admin flow in `docs/FIRST_PRODUCTION_ADMIN.md`.
- The cloud-safe business seed in `supabase/seed.sql`, when you want the local business dataset without team/Auth users.
- The production bootstrap flow in `docs/PRODUCTION_BOOTSTRAP.md`.
- Controlled import scripts for real Snacky history.
- App screens for master data and daily operations.

## Supabase Auth Redirect URLs

For every environment, configure Supabase Auth URL settings:

- Site URL: the app URL for that environment.
- Redirect URLs: the production domain, staging domain, and any Vercel Preview domains used for testing.

Examples:

```text
https://snacky-os.example.com
https://staging-snacky-os.example.com
https://snacky-os-git-staging-your-team.vercel.app
```

If redirect URLs are missing, login or password reset flows can fail even when the app builds correctly.

## Role Testing

Before promoting staging to production, test at least these users:

- Owner/admin: can access dashboard, operations, inventory, machines, finance, reports, team, settings, VMS import, and audit logs.
- Finance: can access finance and cash review workflows.
- Warehouse/supervisor: can access inventory, purchases, storage locations, and operational route workflows according to role.
- Operator: can access only assigned operator routes and execution screens.

Operator checks:

- Cannot access `/finance`.
- Cannot access `/team`.
- Cannot access `/settings`.
- Cannot access `/vms-import`.
- Cannot see product costs, profit, or admin setup pages.

Deactivate one test user in staging and confirm they cannot continue using the app.

Finance and warehouse negative checks:

- Finance cannot access `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
- Warehouse cannot access `/finance`, `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
- Both roles should land on the polished Unauthorized page for blocked pages.

