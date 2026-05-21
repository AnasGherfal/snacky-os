# Production Checklist

Use this before every staging or production launch. For environment rules, see [ENVIRONMENTS.md](./ENVIRONMENTS.md).

## Environment Separation

- [ ] Local development is using local Supabase, or staging Supabase only when intentionally configured.
- [ ] Staging uses Supabase staging and Vercel staging/Preview.
- [ ] Production uses Supabase production and Vercel production.
- [ ] Vercel Preview/Staging environment variables do not point to production Supabase.
- [ ] Vercel Production environment variables do not point to local or staging Supabase.
- [ ] `NEXT_PUBLIC_APP_URL` matches the deployed domain for each environment.
- [ ] Supabase Auth Site URL and redirect URLs include the app domains for staging and production.

## Build And Configuration

- [ ] `npm run build` passes.
- [ ] `.env.example` lists every required runtime variable.
- [ ] Vercel Preview and Production have separate environment variable values where needed.
- [ ] No real secrets are committed to Git.
- [ ] No local Supabase development URL is used by deployed environments.
- [ ] `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE` is not configured in any environment.
- [ ] `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` is not configured in any environment.
- [ ] Security headers are present: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.
- [ ] No strict Content Security Policy is enabled unless it has been tested with Supabase, Storage signed URLs, PWA assets, and image loading.

## Supabase

- [ ] Migrations have been applied with `npx supabase db push`.
- [ ] Schema changes were made through migrations, not manual production edits.
- [ ] Migrations were applied and tested in staging before production.
- [ ] `supabase db reset` was not run against staging.
- [ ] `supabase db reset` was never run against production.
- [ ] `supabase/seed.sql` was run only if you intentionally want the cloud-safe business seed, and it was tested in staging first.
- [ ] Auth users and team access were created through Supabase Auth or the app Team page, not seed SQL.
- [ ] Historical imports were tested in staging before production.
- [ ] Production bootstrap was dry-run first with `npm run bootstrap:production -- --dry-run`.
- [ ] Production bootstrap was run at most once per environment with `--confirm-production-bootstrap`.
- [ ] First production admin is created with a real email.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is configured only in Vercel server-side env vars.
- [ ] Service-role search results are limited to server-only code, scripts, and docs with placeholders.
- [ ] Supabase Auth Site URL matches `NEXT_PUBLIC_APP_URL`.
- [ ] Supabase Auth redirect URLs include production and staging or preview URLs.
- [ ] `profiles` has an authenticated self-read policy using `profiles.id = auth.uid()`.
- [ ] `team_members` has an authenticated self-read policy using `team_members.auth_user_id = auth.uid()`.
- [ ] Storage bucket migration has created `product-images`, `receipt-images`, `machine-photos`, `refill-photos`, and `issue-photos`.
- [ ] `product-images` is public read only; owner/admin write policies exist.
- [ ] `receipt-images` is private and opens only through authenticated signed URLs.
- [ ] `refill-photos` and `issue-photos` require route-scoped object paths that start with the route UUID.
- [ ] RLS and database grants are reviewed before broad production access.

## PWA

- [ ] `/manifest.webmanifest` returns `200`.
- [ ] `/icons/icon-192.png` returns `200`.
- [ ] `/icons/icon-512.png` returns `200`.
- [ ] `/icons/maskable-icon-512.png` returns `200`.
- [ ] `/sw.js` returns `200`.
- [ ] `/offline.html` returns `200`.
- [ ] The deployed site is served over HTTPS.
- [ ] Mobile browser offers install/add-to-home-screen where supported.
- [ ] Offline navigation shows the offline fallback page, not a browser network error.
- [ ] iPhone install was tested with Safari, Share, Add to Home Screen.
- [ ] Android install was tested with Chrome, Menu, Add to Home Screen or Install App.
- [ ] `/install` instructions match [PWA_INSTALL.md](./PWA_INSTALL.md).

## Phone Operator Test

Test on a real phone or a 390px wide responsive viewport.

- [ ] Login form is usable without horizontal scrolling.
- [ ] Operator dashboard cards fit the viewport.
- [ ] `/operator/routes` route cards fit the viewport.
- [ ] Route detail start/end actions are reachable.
- [ ] Pick list quantities can be changed by touch.
- [ ] Machine stop actual fill quantities can be entered by touch.
- [ ] Cash collection input is usable on mobile.
- [ ] Issue report inputs and final photo input are usable on mobile.
- [ ] Sticky complete/cancel actions do not cover important fields.

## Access Control

- [ ] Owner/admin can access dashboards, team, master data, imports, routes, inventory, cash, and finance screens.
- [ ] Owner/admin can create or edit team members and review activity logs.
- [ ] Finance can access finance and cash review workflows.
- [ ] Finance cannot access `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
- [ ] Warehouse/supervisor access matches the intended operations permissions.
- [ ] Warehouse can access inventory, inventory movements, storage locations, and purchases.
- [ ] Warehouse cannot access `/finance`, `/activity`, `/admin`, `/team`, `/settings`, or `/vms-import`.
- [ ] Operator can access only operator routes and execution screens.
- [ ] Operator cannot access product cost/profit or finance screens.
- [ ] Operator cannot access team, settings, admin pages, or VMS import.
- [ ] Unauthorized pages show the polished Unauthorized page.
- [ ] Inactive users are redirected away from the app.
- [ ] A user without a configured Snacky OS profile cannot enter the app.

## Business Workflow

- [ ] Admin can create machines, products, locations, suppliers, storage locations, and machine slots.
- [ ] VMS import works with a real provider CSV or Excel file.
- [ ] VMS product mapping works for unmatched products.
- [ ] Refill recommendations are generated from machine slots, VMS snapshots, par/min quantities, and storage availability.
- [ ] Route creation writes route stops and route stock lines.
- [ ] Operator pick confirmation creates storage-to-operator-bag movements.
- [ ] Machine stop completion creates operator-bag-to-machine movements.
- [ ] Leftover return creates operator-bag-to-storage movements.
- [ ] Cash collection creates expected, actual, and variance values.
- [ ] Issue reporting creates priority, status, assigned user, and SLA due date values.

## Data Safety

- [ ] Production uses real Snacky data only.
- [ ] No local login users such as `admin@snacky.local` exist in production.
- [ ] Supplier costs and finance screens are not available to operators.
- [ ] CSV imports have been checked in preview before running in production.
- [ ] Supabase backups are enabled or the recovery plan is understood.
