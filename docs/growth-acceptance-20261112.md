# Growth hardening continuation — 12 November 2026

## Additional application fix

The operator pickup API previously issued unpaginated reads for route stops, stop items and pick-list lines. A sufficiently large route could be truncated at the API row cap. The new route-scoped helper retrieves complete exact-count pages under a shared deadline and withholds incomplete reads. Authorization is checked before the protected server read, and every page retains the authorized route ID. Known missing-table compatibility remains, but timeouts, permission failures and changing counts cannot silently turn into an empty pick list.

The refill screen also restores bilingual guidance explaining that cash removal is a separate workflow and must not be submitted again as a refill amount.

## Regression verification

A complete repository node:test run on the isolated integration candidate passed 2,126 tests with zero failures; five database-dependent tests were explicitly skipped in this credentials-free run. TypeScript passed. Evidence: GitHub Actions run 43262393097, candidate 00b66c5e8791c67cb84afe70e7cd3a7328297a1e.

Four prior failures were traced to obsolete text/helper assertions. Their replacements assert the actual server guards, authorized recipient list and runtime reuse of shared recommendations, not old implementation spelling. No application permission was broadened.

## Real authenticated acceptance, not just mocks

Workflow `Growth authenticated acceptance` starts a disposable loopback-only Supabase stack, replays the original schema using the documented existing fresh-bootstrap exceptions, creates 20 synthetic operator logins plus an owner, 50 machines and two 1,500-line planning datasets, builds the production Next.js app and runs actual authenticated HTTP/REST requests and Chromium.

First run 43262824189 passed:

- 20 simultaneous authenticated operator route-page requests, each restricted to its own assigned routes.
- 20 concurrent authenticated pickup API reads returning the full assigned lines.
- A 50-machine pickup with all 1,500 product lines.
- 20 attempts to access another operator's route, all rejected.
- Owner route, warehouse, operator-bag, restock and cash page rendering.
- Verification that these reads did not change inventory, cash or financial ledger row counts.
- English and Arabic mobile route rendering at 390 pixels, with no detected horizontal overflow or browser page errors.

The first run's stricter legacy smoke check correctly failed on its own obsolete expectation that a warehouse employee could open `/inventory/movements/new`. Current application policy explicitly reserves this physical stock correction page for owner/admin. The smoke test now verifies owner access and denies warehouse/operator access; the security restriction is preserved. The corrected complete acceptance run must pass before this gate is considered green.

## Stronger test safety

The old smoke test could count a 404 or a permission-denied redirect as a success. It now requires HTTP 200, actual application HTML and no login/unauthorized/error document. Test account creation requires both the application and Supabase endpoints to be local, rejects production and remote targets, tracks partial account creation for cleanup, and never forwards authentication cookies to another origin.

No production users or records are created by this acceptance workflow. The disposable database is destroyed on completion, including failure. Evidence excludes local credential files and redacts tokens from logs.

## Limits

These are finite real authenticated staging reads with synthetic data, not certification of sustained production throughput. They do not yet prove last-unit concurrent stock mutations, a lost-network retry after a cash commit, long retained sales history, a 40-user workload, or a backup-restore drill. No production stock, prices, cash amounts, salaries, Finance entries, roles or policies were changed by this continuation.
