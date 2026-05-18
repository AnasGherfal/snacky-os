# Snacky OS Deployment Guide

This guide prepares Snacky OS for a staging or production deployment on Vercel with Supabase Cloud.

Official references:

- Vercel Next.js deployments: https://vercel.com/docs/concepts/next.js/overview
- Vercel environment variables: https://vercel.com/docs/projects/environment-variables
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Supabase Next.js guide: https://supabase.com/docs/guides/with-nextjs
- Next.js PWA guide: https://nextjs.org/docs/app/guides/progressive-web-apps

## 1. Create The Supabase Cloud Project

1. Create a Supabase project in the Supabase dashboard.
2. Copy the project API URL from the project's API settings.
3. Copy the public client key:
   - Legacy projects: use the `anon` key.
   - New key projects: use the publishable key if available.
4. Copy a server-only elevated key:
   - Legacy projects: use the `service_role` key.
   - New key projects: use the secret key if the app is compatible with it.
5. Keep the elevated key server-only. Never paste it into client code, mobile apps, issue trackers, screenshots, or public docs.

## 2. Apply Database Migrations

From this repository root:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Use `db push` for migrations. Do not run `supabase db reset` against staging or production.

## 3. Seed Policy

Do not run `supabase/seed.sql` against staging or production by default.

That seed file is useful for local development snapshots and includes local-only login users such as `admin@snacky.local` and `operator@snacky.local`. For production, create the first real admin user using [FIRST_PRODUCTION_ADMIN.md](./FIRST_PRODUCTION_ADMIN.md), then enter business data through the app flows or run the one-time production bootstrap in [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md).

If you intentionally need to import historical Snacky data into staging, remove local-only Auth users and any test credentials before running a custom import.

## 4. Configure Supabase Auth

In Supabase Auth URL configuration:

1. Set Site URL to the deployed app URL, for example `https://snacky-os.vercel.app`.
2. Add redirect URLs for every Vercel environment you will test:
   - Production domain.
   - Preview deployment pattern or branch URL, if used.
   - Custom staging domain, if used.
3. Keep email/password login enabled if operators and admins will sign in with email and temporary passwords.

## 5. Configure Vercel

1. Import the Git repository into Vercel as a Next.js app.
2. Set the build command to `npm run build`.
3. Set the install command to the Vercel default or `npm install`.
4. Add these environment variables for Preview and Production:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-or-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-or-secret-key
NEXT_PUBLIC_APP_URL=https://your-vercel-domain.example
NEXT_PUBLIC_APP_LOCALE=en
```

`SUPABASE_SERVICE_ROLE_KEY` is required for Team screens that create or reset Supabase Auth users. It must only exist as a server-side Vercel environment variable.

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

## 9. Rollback

If a production deploy is bad:

1. In Vercel, promote the previous working deployment.
2. Do not roll back database migrations blindly.
3. If data was changed by the bad deployment, review the affected records and restore from Supabase backups or targeted SQL.
