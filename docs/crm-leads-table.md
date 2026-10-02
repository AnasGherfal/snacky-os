# Leads list: compact table and staff handover

This change replaces only the `/locations-pipeline` list presentation. Desktop uses a semantic six-column table: place/area, contact, stage, next action, follow-up due, owner. The header stays visible inside a keyboard-accessible scroll region. Small screens use compact rows with the same record links, stage, next action, date, owner and communication controls. The Arabic layout is RTL; phone values are LTR.

Search, stage, employee and advanced filters use the original `snacky_crm_workspace_v1` read boundary. Server pagination and server ordering are preserved. The UI does not sort only the current page or pretend that page-local counts cover every lead. Dates and missing owners are not fabricated. Failed/unavailable reads have a distinct retryable state, never an empty-success message.

The owner filter presents the existing employee assignment, including the current user. A legacy Mine URL still reads the Mine scope; applying the form submits its displayed employee ID with the All-permitted scope. Both retain the same current-employee assignment constraint, while allowing a manager to choose another employee without intersecting two conflicting owner filters. Access is always checked by the existing database read.

All details, editing, assignment, notes, attachments, follow-up creation and conversion remain in the existing record screens. This release adds no inline writes, bulk assignment, new records, migrations, account changes or automation. It does not publish Company drafts.

## First employee handover (recommended)

Confirm the employee can log in with the intended role and change their temporary password. Review and publish the role guide and the essential lead-visit/customer-issue procedures to the appropriate audience. Add the approved presentation and current brand materials. Select a small first group of leads, open each original record, set the responsible employee, a concrete next action and follow-up date, and save. Do not assign the whole lead list just to fill an empty My Work screen.

Demonstrate one genuine call/visit outcome and one saved follow-up. A shared lead visible to the team is not necessarily assigned to that employee. My Work can be empty even when the employee can view shared leads.

## Verification

`node --experimental-strip-types --test scripts/test-crm-lead-table.mjs scripts/test-connected-relations.mjs scripts/test-authz-permissions.mjs`

The new workflow builds the production application against disposable loopback Auth/REST/Postgres with the repository's documented historical bootstrap exceptions. It checks the real list, server search across pages, owner/stage/overdue filters, paging, private-source denial, operator denial, native assignment-save persistence, mobile/desktop and Arabic accessibility, and original integration suites. Test accounts and leads are synthetic. Nothing in the tests should connect to production.

This is a read-only presentation change with no database installation step. Review exact-head checks and actual screenshots before merging. Code-ready does not imply a live staff walkthrough has occurred.
