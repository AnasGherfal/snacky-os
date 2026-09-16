# Company integration environment and evidence limits

The end-to-end job creates disposable Supabase Auth, PostgREST, Storage and PostgreSQL services on loopback and builds the actual application against them. Accounts, documents and ledger fixtures are synthetic. It does not connect to production, receive production secrets or mutate the connected project.

Company acceptance runs with the feature enabled. The native-workflow suite rebuilds with the feature disabled, using the same real backend that contains the Company schema. The checks therefore cover both application enablement states rather than assuming a flag makes regressions impossible.

## Original repository migration replay

Historical migrations do not recreate an empty database without compatibility handling. The test builder applies the original SQL files, but explicitly:

1. Runs the payroll legacy compatibility bridge after the payroll engine it requires.
2. Rebuilds the incompatible June sales view in the empty fixture and restores its five dependent KPI views from their original definitions, with security-invoker access.
3. Reinstates the original self-only team read policy before a later ALTER POLICY that assumes it still exists.
4. Executes top-level LOCK TABLE migrations in a transaction.

These bootstrap operations are not deployment instructions. Never run the test builder, its DROP VIEW, fixture records or reset/stop commands against a live project. It hardcodes loopback PostgreSQL and requires the disposable project identifier.

## Verified production permission baseline

A read-only check of the connected production project on 2026-09-16 found:

- `snacky_finalize_route_stop_workflow_v1` is SECURITY INVOKER and executable by `service_role`.
- `service_role` already has table-level UPDATE on `route_stop_inventory_commits` in production.
- Replaying the older repository migrations alone removes that UPDATE permission. The existing server-internal finalizer then fails in the fresh database before it can record completion.

The disposable environment mirrors that observed existing service-role permission BEFORE applying Company, so its operational regression tests reflect the verified live baseline. It does not grant that permission to authenticated or anonymous browser users, and it verifies that authenticated callers still cannot execute the server-internal finalizer and that direct service-role inventory-movement insertion remains forbidden. Company does not introduce this grant, alter the finalizer, or change route/stock/cash calculation behavior. No permission was changed in production.

This is explicit schema drift, not proof that a clean, unmodified replay of all historical migrations works. Reconcile and document that drift separately before any blanket database rebuild. Company activation must apply only its reviewed prerequisites and migration, not blindly replay old hardening files.

## Legacy native test adaptations

The route fixture supplies the current canonical pickup writer's provenance and genuine acknowledged line IDs. Its obsolete raw zero-cash inserts are replaced with assertions that stop completion creates no cash removal. These changes adapt the test to the existing protected workflow; they do not relax SQL permissions or change the route implementation.

VMS tests use the actual production build's exported server-action IDs rather than development-only function-name text in public HTML. They accept either a 303 redirect or a streamed 200 action response WITH an explicit redirect header, require the exact persisted import-batch ID and success message in the destination, and verify saved rows/current sources/views. They also require the existing canonical `machine_stock_snapshot` type for legacy `stock` input, guarded against an unexpected change to the importer's canonicalization function. No arbitrary 200, unrelated batch or generic imported status is accepted as proof of success.

Legacy English UI assertions run with an explicit English cookie. Company browser tests independently exercise Arabic and English. A lost response is simulated only after the real request reaches the real backend and commits; the subsequent reload/retry must not create another revision.

## Presentation and narrow existing read repair

The Company area uses scoped contrast/focus improvements, human-readable Arabic/English working-screen labels, an exact draft-review step, explicit historical-version warnings and multipage printing. The actual full-shell screenshots and accessibility outputs are retained as artifacts; they contain QA data, not approved company documents.

The audit also reproduced an existing dashboard route-query ambiguity: `routes` has several foreign keys to `team_members`. The two dashboard route-read shapes now explicitly use `routes_operator_id_fkey`, which was verified read-only in the connected production schema. This corrects a read selector only; no route creation, completion, inventory, payroll or financial calculation is altered.

## What this establishes

These tests exercise a real isolated application/backend, not mocked data responses. They do not establish production deployment, disaster-recovery readiness, every possible workflow, or absolute absence of future failures. The exact head, test results, observed baseline differences, remaining failures and visual review must be recorded in the PR before any release decision. Production activation also requires the prior connected-relations migrations, the Company migration, approved materials and verified backups/rollback.
