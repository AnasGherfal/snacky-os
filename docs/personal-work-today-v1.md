# My Work Today / مهامي اليوم

## Scope
A personal, read-only employee starting screen at `/my-day`, with a sidebar entry. This release does not replace the CRM `/my-work` or operator route home, change login destinations, create a task ledger, or grant any new money/stock permissions. No employee ID or impersonation selector is accepted: even owners see only their own assignments here. Owner-wide oversight remains `/admin/operations`.

### Four compact categories
- Cash: own physical collections or collections currently assigned to the authenticated, authorized counter. Deposit, pickup and count are separate next actions. A box not yet deposited is waiting, not ready for pickup. Missing references and pending-collection placeholders are excluded. Counted zero is still completed history; cash amounts are not exposed.
- Shopping: personally assigned buying lists, safe store names and item progress. A completed checklist with bought items not yet linked to a receipt remains actionable. No supplier prices or contact data are exposed on the starting screen.
- Storage placement: linked purchases from lists assigned to this buyer and bought by them. They may record placement themselves through the original receipt flow; no separate receiver is introduced. Unlinked drafts are not represented as shopping already done.
- Storage counts: assigned personal counts and progress, never expected or counted inventory amounts. Submitted counts explicitly wait for owner review and provide no approval control.

Active, Upcoming and History are separate. Untouched future lists/counts appear in Upcoming, not as overdue work. Completed/cancelled records leave Active. Overdue actionable dates are sorted first, with no invented cash deadline. Each category shows five records per page and full, independently verified totals, not the number of rows on the current page.

## Access and safety
The page and GET-only API enforce operational roles. The public database wrapper is STABLE / SECURITY INVOKER; the private guarded STABLE reader requires a live active canonical profile/team link and filters every query by `auth.uid()` / its linked member. No caller-provided employee ID, raw table grants, service-role client, financial fields or business writers are added.

Existing destination access stays authoritative. Pure operators do not acquire the storage-receipt/stockcount workspaces through this page. Pure purchasing does not acquire stockcount access. Restricted categories are explicitly labelled rather than counted as zero. Ahmed's existing Operator/Warehouse role combination can use all four categories; cash assignment access still depends on his existing counting authorization.

Every action link opens an existing controlled record. No count, purchase, receipt, inventory approval or history correction is executed from this page. Reassignment and permission revocation are reflected by fresh server reads. Historic buying/storage visibility follows current destination access rather than granting old assignees permanent access after reassignment.

## Failure handling
Each category has an independent server deadline, response validation and successful-check timestamp. Missing, malformed or failed reads are unavailable, not empty. The browser cancels outdated requests and discards stale responses after tab changes. Responses are private/no-store. The page never claims notification delivery or read acknowledgement.

## Verification
The dedicated workflow tests source/access/error contracts, a disposable PostgreSQL fixture using original authorization helpers and the actual new migration, and the real component with synthetic English/Arabic data at 320px/390px. Database tests cover cross-employee scope, inactive/mismatched identity, revocation, counted-zero history, missing receipts, same-buyer receiving, waiting approval, pagination and no-write triggers. Browser tests cover independent errors, retries, upcoming/history, record links, paging and cancelled stale requests. Component browser tests are not real staff Auth/PostgREST/phone end-to-end verification.

## Deployment
Build/review only until the PR and matching migration are reviewed. Install the exact CLI-generated `20260926134530_personal_work_today_v1.sql` with the matching app release; do not equate a merged build with an installed database function. No live assignments or permissions are created by deployment. Pilot using real activity recorded by the actual employee, not synthetic production records.

Rollback: remove the new navigation/page integration and revoke the new wrapper/private-reader execution if needed. Existing source tables, ledger writers and workflows are not modified by the migration and require no data rollback. Keep migration-history handling in the normal deployment process; do not rewrite prior history.
