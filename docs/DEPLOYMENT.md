# Snacky OS Deployment Guide

This guide prepares Snacky OS for a staging or production deployment on Vercel with Supabase Cloud.

Official references:

- Vercel Next.js deployments: https://vercel.com/docs/concepts/next.js/overview
- Vercel environment variables: https://vercel.com/docs/projects/environment-variables
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Supabase Next.js guide: https://supabase.com/docs/guides/with-nextjs
- Next.js PWA guide: https://nextjs.org/docs/app/guides/progressive-web-apps

Related Snacky OS docs:

- Environment rules: [ENVIRONMENTS.md](./ENVIRONMENTS.md)
- Production checklist: [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)
- Security checklist: [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)
- Storage setup: [STORAGE_SETUP.md](./STORAGE_SETUP.md)
- Phone install guide: [PWA_INSTALL.md](./PWA_INSTALL.md)

## 0. Environment Model

Snacky OS uses separate app and database environments:

| Environment | App | Database |
| --- | --- | --- |
| Local development | Local Next.js dev server | Local Supabase by default, or staging Supabase when intentionally configured |
| Staging | Vercel staging or Preview deployment | Supabase staging |
| Production | Vercel production deployment | Supabase production |

Vercel environment variables must use the matching cloud Supabase values for staging and production. Do not deploy staging with production Supabase values unless you are intentionally running a production support task.

## 1. Create The Supabase Cloud Project

1. Create separate Supabase projects for staging and production.
2. Copy the project API URL from the project's API settings.
3. Copy the public client key:
   - Legacy projects: use the `anon` key.
   - New key projects: use the publishable key if available.
4. Copy a server-only elevated key:
   - Legacy projects: use the `service_role` key.
   - New key projects: use the secret key if the app is compatible with it.
5. Keep the elevated key server-only. Never paste it into client code, mobile apps, issue trackers, screenshots, or public docs.

## 2. Apply Database Migrations

Use migrations for schema changes. From this repository root, link to the correct Supabase project for the environment:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Run migrations against staging first, test the release, then apply the same migrations to production. Do not run `supabase db reset` against staging or production. Never run `db reset` on production.

## 3. Seed Policy

`supabase/seed.sql` is a business-data seed only. It can be run locally with `npx supabase db reset` or against Supabase Cloud with:

```bash
npx supabase db push
npx supabase db push --include-seed
```

The seed helper functions `public.snacky_seed_clean_text`, `public.snacky_seed_numeric`, and `public.snacky_seed_date` live in migrations, not in `supabase/seed.sql`. Run `npx supabase db push` first so Supabase Cloud applies those helper functions, then run `npx supabase db push --include-seed` to load cloud business data.

The seed inserts operating data such as products, machines, locations, storage locations, suppliers, VMS mappings, machine slots, purchases, purchase lines, financial transactions, and inventory movements. It does not create team members, Supabase Auth users, Auth identities, login sessions, tokens, or passwords.

Create Auth users through Supabase Auth or the app Team page. For production, create the first real admin user using [FIRST_PRODUCTION_ADMIN.md](./FIRST_PRODUCTION_ADMIN.md), then enter additional team members through the app flows. The seed should not be used to overwrite an existing cloud owner user.

Use bootstrap/import flows for larger initial real-data loads. If you intentionally need to import historical Snacky data into staging or production, test the import in staging before production.

## 4. Configure Supabase Auth

In Supabase Auth URL configuration:

1. Set Site URL to the deployed app URL for the environment, for example `https://snacky-os.vercel.app`.
2. Add redirect URLs for every app domain you will test:
   - Production domain.
   - Custom staging domain, if used.
   - Vercel Preview deployment pattern or branch URL, if used.
3. Keep email/password login enabled if operators and admins will sign in with email and temporary passwords.

The migration `supabase/migrations/202605190002_auth_profile_self_read_policies.sql` adds the minimum authenticated self-read policies needed by the app shell:

- `profiles`: users can read their own profile where `profiles.id = auth.uid()`.
- `team_members`: users can read their own team member row where `team_members.auth_user_id = auth.uid()`.

These policies prevent login/profile lookup from failing when Row Level Security is enabled for those tables.

## 5. Configure Vercel

1. Import the Git repository into Vercel as a Next.js app.
2. Set the build command to `npm run build`.
3. Set the install command to the Vercel default or `npm install`.
4. Add these environment variables for Preview/Staging and Production, using the matching Supabase project values:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-or-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-or-secret-key
NEXT_PUBLIC_APP_URL=https://your-vercel-domain.example
NEXT_PUBLIC_APP_LOCALE=en
```

`SUPABASE_SERVICE_ROLE_KEY` is required for Team screens that create or reset Supabase Auth users. It must only exist as a server-side Vercel environment variable.

Preview/Staging should point to Supabase staging. Production should point to Supabase production. Neither deployed environment should use `localhost`, `127.0.0.1`, or local Supabase URLs.

Optional server-side VMS API variables, when the XY/Xingyuan sync is enabled:

```bash
XY_VMS_ENABLED=true
XY_VMS_BASE_URL=http://175.6.71.238:8090/service-api/api
XY_VMS_MERCHANT_ID=your-merchant-id
XY_VMS_KEY=your-xy-key
XY_VMS_SECRET=your-xy-secret
XY_VMS_SIGNING_MODE=signed
```

Optional server-side XY web dashboard fallback variables:

```bash
XY_WEB_API_BASE_URL=https://xcx.xynetweb.com/sram
XY_WEB_API_AUTHORIZATION=your-current-web-dashboard-authorization-token
XY_WEB_MERCHANT_ID=6591
XY_WEB_LANGUAGE=en
XY_WEB_CHANNEL=1
XY_WEB_ENABLED=true
```

Do not prefix XY credentials with `NEXT_PUBLIC_`. They are read only by server-only sync code and must be configured separately for Preview/Staging and Production. Do not store the web dashboard Authorization token in the database or source control; refresh it from the VMS dashboard when it expires.

## 6. Supabase Storage Buckets

The migration `supabase/migrations/202605190001_storage_buckets_policies.sql` creates the production Storage buckets and policies when Supabase Storage is available. It is guarded so local development does not fail if the Storage schema is unavailable.

Buckets:

- `product-images`: public read; owner/admin upload, update, and delete.
- `receipt-images`: private; owner/admin upload, update, and delete; owner/admin/supervisor/warehouse/finance read through authenticated signed URLs.
- `machine-photos`: private; owner/admin upload, update, and delete; active authenticated users can read.
- `refill-photos`: private; owner/admin/supervisor and the operator assigned to the route can upload/read when object paths start with the route UUID.
- `issue-photos`: private; owner/admin/supervisor and the operator assigned to the route can upload/read when object paths start with the route UUID.

Route-scoped operator photo paths must start with the route ID:

```text
refill-photos/<route-id>/<stop-id-or-file-name>.jpg
issue-photos/<route-id>/<issue-or-file-name>.jpg
```

Uploaded receipt files are stored in the private `receipt-images` bucket and opened through `/api/storage/receipt-images/...`, which creates short-lived signed URLs after checking app permissions.

See `docs/STORAGE_SETUP.md` for the full Storage setup and upload safety checklist.

## 7. Deploy

Use either Vercel Git integration or the Vercel CLI.

Git flow:

1. Push to a non-production branch for a Preview deployment.
2. Confirm the app builds and can reach Supabase.
3. Merge to the production branch when ready.

CLI flow:

```bash
npx vercel
npx vercel --prod
```

## 8. Post-Deploy Smoke Test

1. Open `/login` on the deployed URL.
2. Sign in as the first production admin.
3. Visit `/team` and create one operator with login access.
4. Create or verify one machine, product, location, supplier, storage location, and machine slot.
5. Upload a VMS file in `/vms-import`.
6. Generate a route from recommendations.
7. Open the app on a phone-sized screen and complete the operator path:
   - `/operator/routes`
   - route detail
   - pick list
   - machine stop
   - leftovers
8. Verify the PWA shell:
   - Manifest loads at `/manifest.webmanifest`.
   - Service worker loads at `/sw.js`.
   - Offline fallback loads at `/offline.html`.
   - Browser install option appears on supported mobile browsers over HTTPS.
9. Follow [PWA_INSTALL.md](./PWA_INSTALL.md) on an iPhone or Android device.
10. Test owner/admin/operator roles:
   - Owner/admin can access finance, team, settings, VMS import, and audit logs.
   - Operator can access assigned operator routes.
   - Operator cannot access finance, team, settings, VMS import, admin pages, product costs, or profit data.
11. Test finance and warehouse roles:
    - Finance can access finance, finance transactions, purchases, and cash review workflows.
    - Finance cannot access `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
    - Warehouse can access inventory, inventory movements, storage locations, and purchases.
    - Warehouse cannot access `/finance`, `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
12. Confirm response headers on the deployed app:
    - `X-Frame-Options: DENY`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `Permissions-Policy` is present.
    - Do not add strict CSP until tested.

## 9. Rollback

If a production deploy is bad:

1. In Vercel, promote the previous working deployment.
2. Do not roll back database migrations blindly.
3. If data was changed by the bad deployment, review the affected records and restore from Supabase backups or targeted SQL.
