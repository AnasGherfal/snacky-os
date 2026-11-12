# Snacky OS growth hardening — 12 November 2026

## Scope of this change

This is a bounded reliability release, not a claim that every workflow has been redesigned or that production has passed a 20-user load test.

- Operational list reads verify complete counts, paginate beyond the API row cap, retain authorization filters, share deadlines, and withhold incomplete balances.
- Route details stop querying retired `route_pay_breakdowns`; payroll remains in the current payroll module.
- Storage, operator bags, reservations, route stops/items/movements and restock sources use bounded complete reads.
- Opening restock reports no longer writes or repairs route-stock lines. Missing summaries are calculated in memory and disclosed.
- Restock demand fetches only active route statuses and current Tripoli-month sales, instead of entire route/sales history.
- XY comparison no longer treats cashless payments as cash, merges distinct sales on machine identity alone, turns missing amounts into zero, or revives older successful records before deduplication.
- Exact cash intervals are previous-exclusive/current-inclusive; hourly groups use sortable Tripoli timestamps.
- Owner phone shortcuts focus on Routes, Stock, Cash and Finance. Operator Notes, Inventory Review, Receive & Count and the exact-time XY comparison are discoverable in existing modules. Refill history is not deleted.
- Existing cash retry/route-completion tests assert business contracts rather than superseded UI sentences.

No production stock balance, product name/SKU/price, cash count, payroll value or Finance transaction is corrected by this release. No auth role or RLS policy is broadened. No schema migration is included.

## Non-negotiable controls

1. Planned stock is not proof of physically picked, filled or returned stock.
2. A successful report read never creates an inventory, cash or financial movement.
3. Failed/incomplete reads must not appear as zero stock or zero expected sales.
4. Record money once: retries reuse their original request identity; corrections preserve audit history.
5. Cash removal, safe drop-off, owner receipt, physical count and XY reconciliation remain distinct.
6. Internal unnumbered-bag references do not prove a physical seal match. A missing workflow step is not proof of theft.
7. Records with uncertain dates, product mapping or custody remain uncertain until evidence is supplied.
8. Shared warehouse access does not identify who took unrecorded products. Physical access control and verified custody are separate operational requirements.

## Verification layers

`npm run test:growth-hardening` covers pagination, backend caps smaller than requested pages, count drift, duplicate identities, later-page failure, deadlines, 50-machine/1,500-line reads, independent 20-reader fixtures, cash classification, missing money, timestamp boundaries, UI destinations and read-only report behavior.

`npm run test:growth-cash-regression` preserves cash-custody and count distinctions. Existing core route-ledger, role authorization, Finance, purchase, route planning, XY and TypeScript checks run separately. The new focused gate is also part of `prebuild`.

The 20-reader fixture is an in-memory data-integrity test, **not** production throughput measurement, authentication load testing, RLS certification or a multiwriter database race test. Exact-count pagination catches count/identity drift, but is not a transaction-isolated database snapshot. Authoritative mutations must still validate current state atomically.

## Remaining acceptance gates before capacity certification

| Area | Required evidence | Failure must look like |
|---|---|---|
| Simultaneous work | Authenticated isolated staging run: 20 active users, then 40, with at least 50 machines and realistic retained history | Latency/error evidence, not a guessed capacity claim |
| Last-unit pickup race | Two operators attempt the final units; one authorized allocation wins | No negative available stock, no duplicate debit |
| Mobile retry | Disconnect after server commit, reconnect and retry the same command | Same receipt, exactly one movement/posting |
| Cross-user access | Operator/CRM/investor attempt another role's IDs and endpoints | Server rejects access, not merely a hidden button |
| Route completion | Missing physical count, unmatched product, missing required cash/safety evidence, concurrent revision | Clear actionable error; no false completion |
| Cash mix-up correction | Owner reattributes mistaken drop/photo with preserved original submission, no duplicate removal or amount | Full audit linkage; no silent record relabeling |
| Purchase receiving | Box-versus-piece conversion, mixed carton, duplicate receipt, partial delivery | Units and unit cost correct independently |
| Payroll | Partial payment, full month, overlapping runs, advances greater than payable | No double deduction/payment; unclear timing blocked |
| XY feed | Pagination, timezone, terminal/refund states, duplicate imports, card/cash split, stale/incomplete feed | Unknown remains unknown, not a shortage |
| Restore | Restore a backup into an isolated project, replay migrations, reconcile inventory/cash/Finance | Successful measured restore, not “backup enabled” |
| Release | Required checks on protected main, preview authorization/render smoke and rollback procedure | Failed candidate never reaches production |

Suggested staging targets (not measured results): p95 routine navigation <= 1.5 seconds and p95 critical app commits <= 3 seconds excluding clearly labelled external-provider latency; zero duplicate money/stock writes and zero unauthorized reads. Establish hardware/data-volume baseline before adopting final targets.

## Product structure for growth

Keep one operational home per responsibility rather than adding competing dashboards:

- Owner: exceptions and approvals, active routes, cash custody, financial health.
- Operator: assigned/available routes, actual pickup, machine visit, leftovers, cash deposit.
- Warehouse: verified stock, prepared handoffs, physically accepted returns, counts and procurement.
- Finance: actual received/counts, verified reconciliation, expenses, payroll and owner transfers.
- CRM: locations, issues, visits and follow-ups, without finance or stock mutation access.

Retain history and compatibility URLs behind secondary navigation. Deletion of a page requires a usage/dependency audit and a tested redirect, not a judgment that it looks old.

## Prioritized remaining engineering work

1. Baseline authenticated endpoint timings and render failures; review cumulative database hotspot statistics without mistaking them for current-request latency.
2. Review security-advisor function search paths and compromised-password protection individually; do not bulk-modify SECURITY DEFINER functions or grant broader roles.
3. Reconcile live-schema versus repository migration drift, including salary-prepayment schema, and prove clean restore.
4. Finish owner-friendly exception correction flows so legitimate retrospective fixes do not require ad-hoc SQL or impersonated operator actions.
5. Make full bag/warehouse counts verified checkpoints, with unverified movements explicitly separated; preserve reported legacy ledger negatives for investigation.
6. Split large route-planner/import components along tested module boundaries; lazy-load optional analytics, evidence and historical panels.
7. Validate machine-list search/filter/bulk assignment, route assignment collisions, accessibility, Arabic RTL and mobile offline recovery with real role-specific browser sessions.

Do not enable automatic loss deductions or assign theft responsibility from ledger discrepancies alone.
