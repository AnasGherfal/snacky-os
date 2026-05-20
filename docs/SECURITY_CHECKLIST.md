# Snacky OS Security Checklist

Use this checklist before staging or production deployments.

## Environment Boundaries

- Local development may use local Supabase or staging Supabase when intentionally configured.
- Staging must use Supabase staging and Vercel staging/Preview.
- Production must use Supabase production and Vercel production.
- Never use production Supabase values in Vercel Preview unless doing a controlled production support task.
- Never run `supabase db reset` against production.
- Use migrations for schema changes and bootstrap/import flows for initial real data.

## Environment Variables

- `NEXT_PUBLIC_SUPABASE_URL` is public and must point to the correct Supabase project for the environment.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public and must be the Supabase anon/publishable key only.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it in client components, browser code, screenshots, commits, mobile clients, or any `NEXT_PUBLIC_*` variable.
- `NEXT_PUBLIC_APP_URL` must match the deployed app origin, such as `https://snacky-os.example.com`.
- Production and staging must use cloud Supabase URLs and cloud app URLs, not `localhost`, `127.0.0.1`, or local Supabase URLs.
- Store production values in the hosting provider environment settings. Do not commit real `.env.local` values.

## Service Role Key

- The service role key may only be used from server-only code paths.
- In this app, service-role access is centralized through `src/lib/supabase-server.ts`, which imports `server-only`.
- Browser-safe Supabase clients must use only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Do not create variables named `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE` or `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. `next.config.ts` intentionally fails the build if either is present.
- Rotate the service role key immediately if it is ever pasted into a browser, client bundle, public issue, chat, or committed file.

Allowed service-role search results:

- `src/lib/supabase-server.ts`
- Server actions or route handlers that import `getSupabaseAdminClient`.
- Local/admin scripts under `scripts/`.
- Documentation examples using placeholder values only.

Any service-role result in a `"use client"` file, browser component, public asset, PWA file, or `NEXT_PUBLIC_*` variable is a release blocker.

## Authentication And Roles

- Supabase Auth Site URL must match `NEXT_PUBLIC_APP_URL` for the environment.
- Supabase Auth redirect URLs must include production, staging, and any Vercel Preview domains used for login testing.
- Operators must only access operator route execution screens.
- Operators must not access finance, admin, VMS import, product costs, profit, team, or settings pages.
- Owner/admin can access admin setup, VMS import, team, settings, and audit logs.
- Finance can access finance and cash review workflows.
- Warehouse can access inventory and purchase receiving workflows without admin settings.
- Deactivated users must not be able to log in or continue using existing sessions.
- Global `/activity` is owner/admin only. Team member activity pages are owner/admin only.

Role test before production:

- Owner/admin can access dashboard, finance, team, settings, VMS import, admin pages, and audit logs.
- Operator can complete assigned route screens.
- Operator receives Unauthorized or redirect behavior for finance, team, settings, VMS import, admin pages, product costs, and profit data.
- Finance receives Unauthorized for `/activity`, `/admin`, `/team`, `/settings`, and `/vms-import`.
- Warehouse receives Unauthorized for `/activity`, `/admin`, `/team`, `/settings`, `/finance`, and `/vms-import`.

## Supabase RLS

- Enable Row Level Security on sensitive tables before production.
- Prioritize RLS for:
  - `profiles`
  - `team_members`
  - `products`
  - `purchase_orders`
  - `purchase_order_lines`
  - `inventory_movements`
  - `financial_transactions`
  - `cash_collections`
  - `system_activity_logs`
  - `vms_import_batches`
  - `vms_raw_rows`
  - `vms_stock_snapshots`
  - `vms_sales_snapshots`
- Policies should match app roles. Operators should only read or write records tied to their assigned routes.
- Treat RLS as required defense in depth, even when server pages already check roles.

## Storage Policies

- Private buckets need explicit policies.
- Receipt images should be readable only by owner/admin/supervisor/warehouse/finance roles.
- Refill and issue photos should be readable by admins/supervisors and the assigned operator for the related route.
- Product images can be public only if they contain no private supplier or receipt data.
- Never use public buckets for receipts, cash envelopes, private machine photos, or operator issue evidence.

## Headers

`next.config.ts` sets production-safe security headers:

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` with sensitive browser features disabled
- `Strict-Transport-Security` in production

Do not add a strict Content Security Policy until all image, storage, PWA, and Supabase endpoints have been tested.

## PWA And Mobile

- `/manifest.webmanifest`, `/sw.js`, `/offline.html`, and icon paths must stay public and must not contain secrets.
- PWA install uses the same authenticated app shell as the web app.
- Operator mobile pages must continue to rely on role checks, not hidden navigation alone.
- Security headers must not block manifest, icons, service worker, or Storage signed URL flows.

## Release Checks

- Run `npm run build`.
- Search before deploy:
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `service_role`
  - `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE`
- Confirm the search results are server-only code, scripts, or docs, and not client components.
- Confirm `.env.local` is ignored and real secrets are not committed.
- Confirm Supabase Auth Site URL matches `NEXT_PUBLIC_APP_URL`.
