# Snacky OS: zero-service Railway migration preparation

**Status (2026-11-11): PREP ONLY.** The Railway project \`snacky-os-migration-staging\` exists under personal workspace \`AnasGherfal's Projects\` but has **zero services**, domains, volumes, buckets, deployments and shared variables. Nothing in this branch triggers Railway billing. No Vercel/Supabase production changes, DNS cutover, subscriptions, or notifications are performed.

## Current architecture to retain

- Production GitHub repo: \`AnasGherfal/snacky-os\`, branch \`master\`. **Do not** merge this evaluation branch before staging tests.
- Current commercial Next.js 16.4.3 app: Vercel team \`anasgherfals-projects\`, project \`snacky-os\`, production hostname \`snacky-os.vercel.app\`. The Vercel team has eight *additional* project entries, including Snacky website (\`snacky.ly\`), laboratory website (\`alafaqllc.com\`), Turbo website and other projects. Moving just Snacky OS does **not** cancel the team-level Vercel Pro subscription.
- Database/Auth/Storage remain at Supabase project \`thrthmeyhuhxnmizjhqx\`, currently Pro. A hosting migration must **not** also migrate, delete, or reconfigure production database records, cash history, purchase receipts, or refill photos.
- Live XY scheduler uses Supabase \`pg_cron\` and Vault-backed calls to secure Vercel API routes (\`/api/cron/xy-vms\`, \`/api/cron/xy-sales\`, \`/api/cron/xy-stop-quantities\`); there is also a Vercel-configured \`/api/cron/xy-vms\` job at 04:00 UTC. Do not run the same scheduler on both hosts during cutover, and do not expose cron credentials.
- The Supabase function \`snacky_notice_private.wake\` still references the Vercel hostname. This must be carefully repointed at cutover after a tested replacement, without sending the function source or Vault token to logs. Audit all other notification/CRM routines for absolute URLs.
- Push subscriptions and PWA service-worker scopes are origin-sensitive. If workers previously used \`snacky-os.vercel.app\`, moving to \`os.snacky.ly\` requires a controlled user re-subscription/sign-in plan.
- Build-time \`NEXT_PUBLIC_*\` variables and runtime secrets differ. Don't copy Production Vercel secrets into a disposable staging environment; use an isolated test Supabase database only after separate approval.

## What is prepared in this branch (no paid service)

- \`Dockerfile.railway\` is a multi-stage Node 24 container. It runs \`node scripts/next-build.mjs\` rather than repeating the GitHub CI \`prebuild\` test suite on the hosting service, then ships the minimal Next standalone app.
- \`next.config.ts\` enables \`output: "standalone"\` **only** when \`SNACKY_RAILWAY_STANDALONE=1\` (set at Docker build time). It leaves Vercel Next configuration unchanged if later merged.
- \`.dockerignore\` excludes credentials, CI/test files, docs and cached artifacts.
- \`src/app/api/migration-health/route.ts\` offers an unauthenticated *liveness-only* \`{ok:true}\` response; it does **not** imply connectivity to Supabase or safe database access.
- \`deployment/railway-staging.env.example\` lists safe disabled-by-default sync/archive controls, with no credentials.

The migration branch name deliberately **does not** match the current Vercel \`vercel.json\` opt-in deployment branches (\`preview/**\`, \`qa/**\`, \`release/**\`, \`staging\`). Vercel preview deployments are also disabled for Snacky OS. Pushing to this branch should not consume Vercel preview build minutes.

## Pricing comparison (verify at time of deployment)

Railway official pricing:
https://docs.railway.com/pricing/plans
- Railway Free: $0 subscription, up to $1 monthly credits after trial, but very small 0.5 GB RAM/1 vCPU limits and no production SLA. Do not assume Snacky's Next.js server fits this.
- Railway Hobby: $5 minimum monthly subscription **inclusive** of $5 usage, then resource usage above that. Current listed rates: $10 per average occupied GB RAM-month, $20 per utilized vCPU-month, $0.05 per outbound GB. Builds currently free, but service runtime is charged by usage.
- **Illustrative 30-day, always-running service**, ignoring network and extra services: RAM 0.5 GB + CPU 0.05 vCPU average -> $6/month; 1 GB + 0.10 vCPU -> $12/month; 1.5 GB + 0.25 vCPU -> $20/month; 2 GB + 0.30 vCPU -> $26/month. These are scenarios, **NOT** benchmarks or quotes; measured CPU/RAM could be materially different. If resource use is lower than $5, Hobby still bills $5.
- Railway Pro: $20 minimum with $20 included resource usage; not necessarily cheaper than Vercel Pro.
- As of the Nov 1-10 Vercel billing review, the existing team showed approximately $10.45 metered billed cost across those ten days, with ~$7.60 listed as Build CPU Minutes, plus the separate Vercel Pro team commitment; the actual invoice can differ after credits and discounts. Several build safeguards are now live.
- Supabase Pro persists after either hosting choice. For *all hosting* fee savings, the remaining eight Vercel projects must be migrated, retired, or otherwise no longer require a paid Vercel team before cancelling that subscription. Inventory of projects/domains is required before this decision.

## Future staged deployment checklist (requires separate approval to start compute)

1. Confirm exact Railway plan, spending guard and allowed maximum trial cost with owner.
2. Railway project \`3fa6040a-203a-4b50-953a-98e7b2505b4c\`, environment \`d2c5b408-43cf-4b1c-b0a2-6ba56373b38c\`. Deploy the known repo \`AnasGherfal/snacky-os\` from **this migration branch**, not \`master\`. Select \`Dockerfile.railway\` explicitly through service \`dockerfilePath\`, set one replica and no Railway cron. Do not attach domains used in production.
3. First smoke pass: **NO** Supabase, XY or VAPID credentials. Check container reaches ready, port \`$PORT\`, and the generated Railway domain's \`/api/migration-health\` returns 200. Failure to navigate authenticated pages is expected and must not be interpreted as an app regression.
4. Before testing a real login or write operation, create or choose a **separate isolated** test database and staged users (separate cost approval). Never attach the production Supabase service-role secret to public staging; never trigger live XY sync or send push notifications to real users.
5. Test: owner and operator logins/permissions; inventory quantities and movements; route completion; sealed cash handling, cash collection and reconciliation; receipt uploads; photo proof and quantity confirmation; vending sales dashboards; push subscriptions; and read-only XY mock data. Test stale-data and error cases.
6. Measure at least 24h of staging CPU, RAM, network egress, latency and errors; compute expected full-month Railway usage. Compare Vercel current period including base subscription, usage credit, and remaining eight projects. Only after the net savings are verified should a cutover be proposed.
7. Cutover requires one canonical domain (\`os.snacky.ly\` is an option but not yet owned/verified at Railway), new app URL, secure secrets, correct OAuth redirect origins and PWA/push subscription migration. Update Vault-backed \`pg_cron\` callbacks **exactly once** to the new host. Do not run two active sync workers.
8. Keep Vercel rollback path and Supabase database intact until staged cutover is verified. Confirm all Vercel-hosted projects before considering team cancellation.

## No-charge acceptance checks for this branch

- No \`mcp__Railway__create_deployment\`, \`create_service\`, \`generate_domain\`, \`create_volume\` or paid resources were invoked.
- No production Vercel settings, billing plans, DNS, Supabase data or cron callbacks were changed during this preparation.
- No PR is opened, so this branch does not trigger the repository's pull-request regression sweep.
- See \`scripts/test-railway-migration-prep.mjs\` for static safety checks; they can run offline with \`node --test\`.
